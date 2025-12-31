import type { Extension, Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { Editor, MarkdownView } from 'obsidian'

import { getChatModelClient } from '../../../core/llm/manager'
import {
  DEFAULT_TAB_COMPLETION_OPTIONS,
  DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
  DEFAULT_TAB_COMPLETION_TRIGGERS,
  type SmartComposerSettings,
  TAB_COMPLETION_CONSTRAINTS_PLACEHOLDER,
  type TabCompletionTrigger,
  computeMaxTokens,
  splitContextRange,
} from '../../../settings/schema/setting.types'
import type { ConversationOverrideSettings } from '../../../types/conversation-settings.types'
import type {
  LLMRequestNonStreaming,
  LLMRequestStreaming,
  RequestMessage,
} from '../../../types/llm/request'
import type { LLMResponseStreaming } from '../../../types/llm/response'
import { escapeMarkdownSpecialChars } from '../../../utils/markdown-escape'
import type { InlineSuggestionGhostPayload } from '../inline-suggestion/inlineSuggestion'

type TabCompletionSuggestion = {
  editor: Editor
  view: EditorView
  text: string
  cursorOffset: number
}

type ActiveInlineSuggestion = {
  source: 'tab' | 'continuation'
  editor: Editor
  view: EditorView
  fromOffset: number
  text: string
} | null

type TabCompletionDeps = {
  getSettings: () => SmartComposerSettings
  getEditorView: (editor: Editor) => EditorView | null
  getActiveMarkdownView: () => MarkdownView | null
  getActiveConversationOverrides: () => ConversationOverrideSettings | undefined
  resolveContinuationParams: (overrides?: ConversationOverrideSettings) => {
    temperature?: number
    topP?: number
    stream: boolean
    useVaultSearch: boolean
  }
  getActiveFileTitle: () => string
  setInlineSuggestionGhost: (
    view: EditorView,
    payload: InlineSuggestionGhostPayload,
  ) => void
  clearInlineSuggestion: () => void
  setActiveInlineSuggestion: (suggestion: ActiveInlineSuggestion) => void
  addAbortController: (controller: AbortController) => void
  removeAbortController: (controller: AbortController) => void
  isContinuationInProgress: () => boolean
}

const MASK_TAG = '<mask/>'
const ANSWER_PREFIX = 'answer:'
const TAB_COMPLETION_CONSTRAINTS_BLOCK = `\n\nAdditional constraints:\n${TAB_COMPLETION_CONSTRAINTS_PLACEHOLDER}`

const applyTabCompletionConstraints = (
  prompt: string,
  constraints: string,
): string => {
  const trimmed = constraints.trim()
  if (!trimmed) {
    return prompt
      .replace(TAB_COMPLETION_CONSTRAINTS_BLOCK, '')
      .replace(TAB_COMPLETION_CONSTRAINTS_PLACEHOLDER, '')
      .replace(/\n{3,}/g, '\n\n')
  }
  if (!prompt.includes(TAB_COMPLETION_CONSTRAINTS_PLACEHOLDER)) {
    return `${prompt}\n\nAdditional constraints:\n${trimmed}`
  }
  return prompt.replace(TAB_COMPLETION_CONSTRAINTS_PLACEHOLDER, trimmed)
}

const parseMaskedAnswer = (raw: string): string => {
  const normalized = raw.trim()
  const markerIndex = normalized.toLowerCase().indexOf(ANSWER_PREFIX)
  if (markerIndex === -1) return normalized
  return normalized.slice(markerIndex + ANSWER_PREFIX.length).trim()
}

const parseMaskedAnswerStreaming = (raw: string): string => {
  const normalized = raw.trim()
  const markerIndex = normalized.toLowerCase().indexOf(ANSWER_PREFIX)
  if (markerIndex === -1) return ''
  return normalized.slice(markerIndex + ANSWER_PREFIX.length).trim()
}

const findBoundaryIndex = (text: string): number | null => {
  let earliest = text.indexOf('\n\n')
  const limit = earliest === -1 ? text.length : earliest

  const boundaryPatterns = [
    /^#{1,6}\s/,
    /^-\s+\[[ xX]\]\s+/,
    /^[-*+]\s+/,
    /^\d+\.\s+/,
    /^>\s+/,
    /^```/,
  ]

  let lineStart = 0
  while (lineStart < text.length) {
    if (lineStart > limit) break
    const lineEnd = text.indexOf('\n', lineStart)
    const actualEnd = lineEnd === -1 ? text.length : lineEnd
    if (lineStart > 0) {
      const line = text.slice(lineStart, actualEnd)
      const trimmed = line.trimStart()
      if (boundaryPatterns.some((pattern) => pattern.test(trimmed))) {
        const boundaryIndex = Math.max(0, lineStart - 1)
        earliest =
          earliest === -1 ? boundaryIndex : Math.min(earliest, boundaryIndex)
        break
      }
    }
    if (lineEnd === -1) break
    lineStart = lineEnd + 1
  }

  return earliest === -1 ? null : earliest
}

const extractAfterContext = (window: string): string => {
  if (!window) return ''
  const boundary = findBoundaryIndex(window)
  const candidate = boundary === null ? window : window.slice(0, boundary)
  if (candidate.trim().length > 0) return candidate

  const firstNonWhitespace = window.search(/\S/)
  if (firstNonWhitespace === -1) return ''
  const trimmed = window.slice(firstNonWhitespace)
  const nextBoundary = findBoundaryIndex(trimmed)
  return nextBoundary === null ? trimmed : trimmed.slice(0, nextBoundary)
}

const extractBeforeContext = (window: string): string => {
  if (!window) return ''
  const lastParagraphBreak = window.lastIndexOf('\n\n')
  if (lastParagraphBreak !== -1 && lastParagraphBreak + 2 < window.length) {
    return window.slice(lastParagraphBreak + 2)
  }
  return window
}

const extractMaskedContext = (
  doc: Text,
  cursorOffset: number,
  maxBeforeChars: number,
  maxAfterChars: number,
): { before: string; after: string } => {
  const beforeStart = Math.max(0, cursorOffset - maxBeforeChars)
  const beforeWindow = doc.sliceString(beforeStart, cursorOffset)
  const before = extractBeforeContext(beforeWindow)

  if (maxAfterChars <= 0) {
    return { before, after: '' }
  }

  const afterEnd = Math.min(doc.length, cursorOffset + maxAfterChars)
  const afterWindow = doc.sliceString(cursorOffset, afterEnd)
  const after = extractAfterContext(afterWindow)

  return { before, after }
}

export class TabCompletionController {
  private tabCompletionTimer: ReturnType<typeof setTimeout> | null = null
  private tabCompletionAbortController: AbortController | null = null
  private tabCompletionSuggestion: TabCompletionSuggestion | null = null
  private tabCompletionPending: {
    editor: Editor
    cursorOffset: number
  } | null = null

  constructor(private readonly deps: TabCompletionDeps) {}

  createTriggerExtension(): Extension {
    return EditorView.updateListener.of((update) => {
      if (!update.docChanged) return

      const markdownView = this.deps.getActiveMarkdownView()
      const editor = markdownView?.editor
      if (!editor) return

      const activeView = this.deps.getEditorView(editor)
      if (activeView && activeView !== update.view) return

      this.handleEditorChange(editor)
    })
  }

  private getTabCompletionOptions() {
    const settings = this.deps.getSettings()
    const rawOptions = settings.continuationOptions?.tabCompletionOptions ?? {}
    const merged = {
      ...DEFAULT_TAB_COMPLETION_OPTIONS,
      ...rawOptions,
    }

    // Compute maxBeforeChars and maxAfterChars from contextRange
    const { maxBeforeChars, maxAfterChars } = splitContextRange(
      merged.contextRange,
    )

    // Compute maxTokens from maxSuggestionLength
    const maxTokens = computeMaxTokens(merged.maxSuggestionLength)

    return {
      ...merged,
      maxBeforeChars,
      maxAfterChars,
      maxTokens,
      maxRetries: 1, // Fixed retry count
    }
  }

  private getTabCompletionTriggers(): TabCompletionTrigger[] {
    const settings = this.deps.getSettings()
    return (
      settings.continuationOptions?.tabCompletionTriggers ??
      DEFAULT_TAB_COMPLETION_TRIGGERS
    )
  }

  private shouldTrigger(view: EditorView, cursorOffset: number): boolean {
    const triggers = this.getTabCompletionTriggers().filter(
      (trigger) => trigger.enabled,
    )
    if (triggers.length === 0) return false

    const doc = view.state.doc
    const windowSize = Math.min(
      this.getTabCompletionOptions().contextRange,
      2000,
    )
    const beforeWindow = doc.sliceString(
      Math.max(0, cursorOffset - windowSize),
      cursorOffset,
    )
    const beforeWindowTrimmed = beforeWindow.replace(/\s+$/, '')

    for (const trigger of triggers) {
      if (!trigger.pattern || trigger.pattern.trim().length === 0) {
        continue
      }
      if (trigger.type === 'string') {
        if (
          beforeWindow.endsWith(trigger.pattern) ||
          beforeWindowTrimmed.endsWith(trigger.pattern)
        ) {
          return true
        }
        continue
      }
      try {
        const regex = new RegExp(trigger.pattern)
        if (regex.test(beforeWindow) || regex.test(beforeWindowTrimmed)) {
          return true
        }
      } catch {
        // Ignore invalid regex patterns.
      }
    }
    return false
  }

  clearTimer() {
    if (this.tabCompletionTimer) {
      clearTimeout(this.tabCompletionTimer)
      this.tabCompletionTimer = null
    }
    this.tabCompletionPending = null
  }

  cancelRequest() {
    if (!this.tabCompletionAbortController) return
    try {
      this.tabCompletionAbortController.abort()
    } catch {
      // Ignore abort errors; controller might already be closed.
    }
    this.deps.removeAbortController(this.tabCompletionAbortController)
    this.tabCompletionAbortController = null
  }

  clearSuggestion() {
    if (this.tabCompletionSuggestion) {
      const { view } = this.tabCompletionSuggestion
      if (view) {
        this.deps.setInlineSuggestionGhost(view, null)
      }
      this.tabCompletionSuggestion = null
    }
  }

  handleEditorChange(editor: Editor) {
    this.clearTimer()
    this.cancelRequest()

    const settings = this.deps.getSettings()
    if (!settings.continuationOptions?.enableTabCompletion) {
      this.deps.clearInlineSuggestion()
      return
    }

    if (this.deps.isContinuationInProgress()) {
      this.deps.clearInlineSuggestion()
      return
    }

    this.deps.clearInlineSuggestion()
    const view = this.deps.getEditorView(editor)
    if (!view) return
    const selection = editor.getSelection()
    if (selection && selection.length > 0) return
    const cursorOffset = view.state.selection.main.head
    if (!this.shouldTrigger(view, cursorOffset)) return
    const options = this.getTabCompletionOptions()
    const delay = Math.max(0, options.triggerDelayMs)
    this.tabCompletionPending = { editor, cursorOffset }
    this.tabCompletionTimer = setTimeout(() => {
      if (!this.tabCompletionPending) return
      if (this.tabCompletionPending.editor !== editor) return
      const currentView = this.deps.getEditorView(editor)
      if (!currentView) return
      if (currentView.state.selection.main.head !== cursorOffset) return
      const currentSelection = editor.getSelection()
      if (currentSelection && currentSelection.length > 0) return
      if (this.deps.isContinuationInProgress()) return
      void this.run(editor, cursorOffset)
    }, delay)
  }

  async run(editor: Editor, scheduledCursorOffset: number) {
    try {
      const settings = this.deps.getSettings()
      if (!settings.continuationOptions?.enableTabCompletion) return
      if (this.deps.isContinuationInProgress()) return

      const view = this.deps.getEditorView(editor)
      if (!view) return
      if (view.state.selection.main.head !== scheduledCursorOffset) return
      const selection = editor.getSelection()
      if (selection && selection.length > 0) return

      const options = this.getTabCompletionOptions()

      const doc = view.state.doc
      const beforeWindow = doc.sliceString(
        Math.max(0, scheduledCursorOffset - options.maxBeforeChars),
        scheduledCursorOffset,
      )
      const beforeWindowLength = beforeWindow.trim().length
      const { before, after } = extractMaskedContext(
        doc,
        scheduledCursorOffset,
        options.maxBeforeChars,
        options.maxAfterChars,
      )
      const beforeLength = before.trim().length
      if (!before || beforeLength === 0) return
      if (beforeWindowLength < options.minContextLength) return

      let modelId = settings.continuationOptions?.tabCompletionModelId
      if (!modelId || modelId.length === 0) {
        modelId = settings.continuationOptions?.continuationModelId
      }
      if (!modelId) return

      const sidebarOverrides = this.deps.getActiveConversationOverrides()
      const { temperature, topP } =
        this.deps.resolveContinuationParams(sidebarOverrides)

      const { providerClient, model } = getChatModelClient({
        settings,
        modelId,
      })

      const fileTitle = this.deps.getActiveFileTitle()
      const titleSection = fileTitle ? `File title: ${fileTitle}\n\n` : ''
      const baseSystemPrompt =
        settings.continuationOptions?.tabCompletionSystemPrompt ??
        DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT
      const tabCompletionConstraints =
        settings.continuationOptions?.tabCompletionConstraints ?? ''
      const systemPrompt = applyTabCompletionConstraints(
        baseSystemPrompt,
        tabCompletionConstraints,
      )

      const isBaseModel = Boolean(model.isBaseModel)
      const baseModelSpecialPrompt = (
        settings.chatOptions?.baseModelSpecialPrompt ?? ''
      ).trim()
      const basePromptSection =
        isBaseModel && baseModelSpecialPrompt.length > 0
          ? `${baseModelSpecialPrompt}\n\n`
          : ''
      const contextWithMask = `${before}${MASK_TAG}${after}`
      const userContent = isBaseModel
        ? `${basePromptSection}${systemPrompt}\n\n${titleSection}${contextWithMask}`
        : `${basePromptSection}${titleSection}${contextWithMask}`

      const requestMessages: RequestMessage[] = [
        ...(isBaseModel
          ? []
          : [
              {
                role: 'system' as const,
                content: systemPrompt,
              },
            ]),
        {
          role: 'user' as const,
          content: userContent,
        },
      ]

      this.cancelRequest()
      this.deps.clearInlineSuggestion()
      this.tabCompletionPending = null

      const baseRequest: LLMRequestNonStreaming = {
        model: model.model,
        messages: requestMessages,
        stream: false,
        max_tokens: Math.max(16, Math.min(options.maxTokens, 2000)),
      }
      if (typeof options.temperature === 'number') {
        baseRequest.temperature = Math.min(Math.max(options.temperature, 0), 2)
      } else if (typeof temperature === 'number') {
        baseRequest.temperature = Math.min(Math.max(temperature, 0), 2)
      } else {
        baseRequest.temperature = DEFAULT_TAB_COMPLETION_OPTIONS.temperature
      }
      if (typeof topP === 'number') {
        baseRequest.top_p = topP
      }
      const requestTimeout = Math.max(0, options.requestTimeoutMs)
      const attempts = Math.max(0, Math.floor(options.maxRetries)) + 1

      const updateSuggestion = (
        suggestionText: string,
        currentView: EditorView,
      ) => {
        let cleaned = suggestionText.replace(/\r\n/g, '\n').replace(/\s+$/, '')
        if (!cleaned.trim()) return
        if (/^[\s\n\t]+$/.test(cleaned)) return
        cleaned = cleaned.replace(/^[\s\n\t]+/, '')
        if (cleaned.length > options.maxSuggestionLength) {
          cleaned = cleaned.slice(0, options.maxSuggestionLength)
        }

        this.deps.setInlineSuggestionGhost(currentView, {
          from: scheduledCursorOffset,
          text: cleaned,
        })
        this.deps.setActiveInlineSuggestion({
          source: 'tab',
          editor,
          view: currentView,
          fromOffset: scheduledCursorOffset,
          text: cleaned,
        })
        this.tabCompletionSuggestion = {
          editor,
          view: currentView,
          text: cleaned,
          cursorOffset: scheduledCursorOffset,
        }
      }

      for (let attempt = 0; attempt < attempts; attempt++) {
        const controller = new AbortController()
        this.tabCompletionAbortController = controller
        this.deps.addAbortController(controller)

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null
        if (requestTimeout > 0) {
          timeoutHandle = setTimeout(() => controller.abort(), requestTimeout)
        }

        try {
          let stream: AsyncIterable<LLMResponseStreaming>
          try {
            const streamingRequest: LLMRequestStreaming = {
              ...baseRequest,
              stream: true,
            }
            stream = await providerClient.streamResponse(
              model,
              streamingRequest,
              { signal: controller.signal },
            )
          } catch (error) {
            const msg = String(error?.message ?? '')
            const shouldFallback =
              /protocol error|unexpected EOF|incomplete envelope/i.test(msg)
            if (!shouldFallback) throw error

            const response = await providerClient.generateResponse(
              model,
              baseRequest,
              { signal: controller.signal },
            )
            let suggestion = response.choices?.[0]?.message?.content ?? ''
            suggestion = parseMaskedAnswer(suggestion)

            const currentView = this.deps.getEditorView(editor)
            if (!currentView) return
            if (currentView.state.selection.main.head !== scheduledCursorOffset)
              return
            if (editor.getSelection()?.length) return

            updateSuggestion(suggestion, currentView)
            if (timeoutHandle) clearTimeout(timeoutHandle)
            return
          }

          let rawText = ''
          for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content ?? ''
            if (!delta) continue
            rawText += delta

            const currentView = this.deps.getEditorView(editor)
            if (!currentView) return
            if (currentView.state.selection.main.head !== scheduledCursorOffset)
              return
            if (editor.getSelection()?.length) return

            const suggestion = parseMaskedAnswerStreaming(rawText)
            if (!suggestion) continue
            updateSuggestion(suggestion, currentView)
          }

          if (rawText.length === 0) return
          const finalSuggestion = parseMaskedAnswer(rawText)
          const currentView = this.deps.getEditorView(editor)
          if (!currentView) return
          if (currentView.state.selection.main.head !== scheduledCursorOffset)
            return
          if (editor.getSelection()?.length) return

          updateSuggestion(finalSuggestion, currentView)
          if (timeoutHandle) clearTimeout(timeoutHandle)
          return
        } catch (error) {
          if (timeoutHandle) clearTimeout(timeoutHandle)

          const aborted =
            controller.signal.aborted || error?.name === 'AbortError'
          if (attempt < attempts - 1 && aborted) {
            this.deps.removeAbortController(controller)
            this.tabCompletionAbortController = null
            continue
          }
          if (error?.name === 'AbortError') {
            return
          }
          console.error('Tab completion failed:', error)
          return
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle)
          }
          if (this.tabCompletionAbortController === controller) {
            this.deps.removeAbortController(controller)
            this.tabCompletionAbortController = null
          } else {
            this.deps.removeAbortController(controller)
          }
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError') return
      console.error('Tab completion failed:', error)
    } finally {
      if (this.tabCompletionAbortController) {
        this.deps.removeAbortController(this.tabCompletionAbortController)
        this.tabCompletionAbortController = null
      }
    }
  }

  tryAcceptFromView(view: EditorView): boolean {
    const suggestion = this.tabCompletionSuggestion
    if (!suggestion) return false
    if (suggestion.view !== view) return false

    if (view.state.selection.main.head !== suggestion.cursorOffset) {
      this.deps.clearInlineSuggestion()
      return false
    }

    const editor = suggestion.editor
    if (this.deps.getEditorView(editor) !== view) {
      this.deps.clearInlineSuggestion()
      return false
    }

    if (editor.getSelection()?.length) {
      this.deps.clearInlineSuggestion()
      return false
    }

    const cursor = editor.getCursor()
    const suggestionText = escapeMarkdownSpecialChars(suggestion.text, {
      escapeAngleBrackets: true,
      preserveCodeBlocks: true,
    })
    this.deps.clearInlineSuggestion()
    editor.replaceRange(suggestionText, cursor, cursor)

    const parts = suggestionText.split('\n')
    const endCursor =
      parts.length === 1
        ? { line: cursor.line, ch: cursor.ch + parts[0].length }
        : {
            line: cursor.line + parts.length - 1,
            ch: parts[parts.length - 1].length,
          }
    editor.setCursor(endCursor)
    return true
  }
}
