import type { Editor } from 'obsidian'

import type { EditorView } from '@codemirror/view'

import { getChatModelClient } from '../../../core/llm/manager'
import {
  DEFAULT_TAB_COMPLETION_OPTIONS,
  DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
  type SmartComposerSettings,
} from '../../../settings/schema/setting.types'
import type { ConversationOverrideSettings } from '../../../types/conversation-settings.types'
import type { LLMRequestNonStreaming, RequestMessage } from '../../../types/llm/request'
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

export class TabCompletionController {
  private tabCompletionTimer: ReturnType<typeof setTimeout> | null = null
  private tabCompletionAbortController: AbortController | null = null
  private tabCompletionSuggestion: TabCompletionSuggestion | null = null
  private tabCompletionPending: {
    editor: Editor
    cursorOffset: number
  } | null = null

  constructor(private readonly deps: TabCompletionDeps) {}

  private getTabCompletionOptions() {
    const settings = this.deps.getSettings()
    return {
      ...DEFAULT_TAB_COMPLETION_OPTIONS,
      ...(settings.continuationOptions?.tabCompletionOptions ?? {}),
    }
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
    this.schedule(editor)
  }

  schedule(editor: Editor) {
    const settings = this.deps.getSettings()
    if (!settings.continuationOptions?.enableTabCompletion) return
    const view = this.deps.getEditorView(editor)
    if (!view) return
    const selection = editor.getSelection()
    if (selection && selection.length > 0) return
    const cursorOffset = view.state.selection.main.head

    const options = this.getTabCompletionOptions()
    const delay = Math.max(0, options.triggerDelayMs)

    this.clearTimer()
    this.tabCompletionPending = { editor, cursorOffset }
    this.tabCompletionTimer = setTimeout(() => {
      if (!this.tabCompletionPending) return
      if (this.tabCompletionPending.editor !== editor) return
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

      const cursorPos = editor.getCursor()
      const headText = editor.getRange({ line: 0, ch: 0 }, cursorPos)
      const headLength = headText.trim().length
      if (!headText || headLength === 0) return
      if (headLength < options.minContextLength) return

      const context =
        headText.length > options.maxContextChars
          ? headText.slice(-options.maxContextChars)
          : headText

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
      const customSystemPrompt = (
        settings.continuationOptions?.tabCompletionSystemPrompt ?? ''
      ).trim()
      const systemPrompt =
        customSystemPrompt.length > 0
          ? customSystemPrompt
          : DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT

      const isBaseModel = Boolean(model.isBaseModel)
      const baseModelSpecialPrompt = (
        settings.chatOptions?.baseModelSpecialPrompt ?? ''
      ).trim()
      const basePromptSection =
        isBaseModel && baseModelSpecialPrompt.length > 0
          ? `${baseModelSpecialPrompt}\n\n`
          : ''
      const userContent = isBaseModel
        ? `${basePromptSection}${systemPrompt}\n\n${context}\n\nPredict the next words that continue naturally.`
        : `${basePromptSection}${titleSection}Recent context:\n\n${context}\n\nProvide the next words that would help continue naturally.`

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

      const controller = new AbortController()
      this.tabCompletionAbortController = controller
      this.deps.addAbortController(controller)

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

      this.cancelRequest()
      this.deps.clearInlineSuggestion()
      this.tabCompletionPending = null

      for (let attempt = 0; attempt < attempts; attempt++) {
        const controller = new AbortController()
        this.tabCompletionAbortController = controller
        this.deps.addAbortController(controller)

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null
        if (requestTimeout > 0) {
          timeoutHandle = setTimeout(() => controller.abort(), requestTimeout)
        }

        try {
          const response = await providerClient.generateResponse(
            model,
            baseRequest,
            { signal: controller.signal },
          )

          if (timeoutHandle) clearTimeout(timeoutHandle)

          let suggestion = response.choices?.[0]?.message?.content ?? ''
          suggestion = suggestion.replace(/\r\n/g, '\n').replace(/\s+$/, '')
          if (!suggestion.trim()) return
          if (/^[\s\n\t]+$/.test(suggestion)) return

          // Avoid leading line breaks which look awkward in ghost text
          suggestion = suggestion.replace(/^[\s\n\t]+/, '')

          // Guard against large multiline insertions
          if (suggestion.length > options.maxSuggestionLength) {
            suggestion = suggestion.slice(0, options.maxSuggestionLength)
          }

          const currentView = this.deps.getEditorView(editor)
          if (!currentView) return
          if (currentView.state.selection.main.head !== scheduledCursorOffset)
            return
          if (editor.getSelection()?.length) return

          this.deps.setInlineSuggestionGhost(currentView, {
            from: scheduledCursorOffset,
            text: suggestion,
          })
          this.deps.setActiveInlineSuggestion({
            source: 'tab',
            editor,
            view: currentView,
            fromOffset: scheduledCursorOffset,
            text: suggestion,
          })
          this.tabCompletionSuggestion = {
            editor,
            view: currentView,
            text: suggestion,
            cursorOffset: scheduledCursorOffset,
          }
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
    const suggestionText = suggestion.text
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
    this.schedule(editor)
    return true
  }
}
