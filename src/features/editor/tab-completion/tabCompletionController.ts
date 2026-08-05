import type { Extension, Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { Editor, MarkdownView } from 'obsidian'

import { isRequestErrorNonRetryable } from '../../../core/ai/requestRetry'
import { executeSingleTurn } from '../../../core/ai/single-turn'
import { getChatModelClient } from '../../../core/llm/manager'
import { promoteProviderTransportModeToObsidian } from '../../../core/llm/transportModePromotion'
import {
  DEFAULT_TAB_COMPLETION_LENGTH_PRESET,
  DEFAULT_TAB_COMPLETION_OPTIONS,
  DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
  DEFAULT_TAB_COMPLETION_TRIGGERS,
  TAB_COMPLETION_CONSTRAINTS_PLACEHOLDER,
  type TabCompletionLengthPreset,
  type TabCompletionTrigger,
  type YoloSettings,
  splitContextRange,
} from '../../../settings/schema/setting.types'
import type { ConversationOverrideSettings } from '../../../types/conversation-settings.types'
import type { LLMRequestBase, RequestMessage } from '../../../types/llm/request'
import { escapeMarkdownSpecialChars } from '../../../utils/markdown-escape'
import type {
  InlineSuggestionGhostPayload,
  TabCompletionCandidateStatus,
  TabCompletionDisplayPayload,
} from '../inline-suggestion/inlineSuggestion'

const TAB_COMPLETION_MIN_CONTEXT_LENGTH = 5

type TabCompletionSuggestion = {
  editor: Editor
  view: EditorView
  cursorOffset: number
  replaceFromOffset: number | null
  candidates: Array<{
    text: string
    status: TabCompletionCandidateStatus
  }>
  selectedIndex: number
  hasUserNavigated: boolean
  multipleCandidates: boolean
}

type ActiveInlineSuggestion = {
  source: 'tab' | 'continuation'
  editor: Editor
  view: EditorView
  fromOffset: number
  text: string
} | null

type TabCompletionDeps = {
  getSettings: () => YoloSettings
  setSettings: (newSettings: YoloSettings) => Promise<boolean>
  getEditorView: (editor: Editor) => EditorView | null
  getActiveMarkdownView: () => MarkdownView | null
  getActiveConversationOverrides: () => ConversationOverrideSettings | undefined
  resolveContinuationParams: (overrides?: ConversationOverrideSettings) => {
    temperature?: number
    topP?: number
    stream: boolean
  }
  getActiveFileTitle: () => string
  setTabCompletionDisplay: (
    view: EditorView,
    payload: TabCompletionDisplayPayload,
  ) => void
  setInlineSuggestionGhost: (
    view: EditorView,
    payload: InlineSuggestionGhostPayload,
  ) => void
  showTabLoadingDots: (view: EditorView, from: number) => void
  hideTabLoadingDots: (view: EditorView) => void
  getSwitchSuggestionHint: () => string
  clearInlineSuggestion: () => void
  setActiveInlineSuggestion: (suggestion: ActiveInlineSuggestion) => void
  addAbortController: (controller: AbortController) => void
  removeAbortController: (controller: AbortController) => void
  isContinuationInProgress: () => boolean
}

const MASK_TAG = '<mask/>'
const TAB_COMPLETION_CANDIDATE_COUNT = 3
const TAB_COMPLETION_CANDIDATE_SEPARATOR = '<yolo_next_suggestion/>'
const TAB_COMPLETION_CONSTRAINTS_BLOCK = `\n\nAdditional constraints:\n${TAB_COMPLETION_CONSTRAINTS_PLACEHOLDER}`
const TAB_COMPLETION_MULTIPLE_CANDIDATES_CONSTRAINT =
  `Generate exactly ${TAB_COMPLETION_CANDIDATE_COUNT} candidate completions in sequence. ` +
  `Separate them with the exact token ${TAB_COMPLETION_CANDIDATE_SEPARATOR}. ` +
  'Each candidate must independently fit the text before and after the cursor, match the existing language, tone, format, and writing style, and must not refer to the other candidates. ' +
  'When the context allows, offer meaningfully different continuation directions instead of superficial paraphrases or identical openings. ' +
  'Never sacrifice correctness, coherence, or direct insertability for variety; if the context strongly supports only one continuation, similar candidates are acceptable. ' +
  'Do not number or label the candidates, and do not output the separator inside a candidate.'

const trimPartialSeparator = (text: string): string => {
  const maxPrefixLength = Math.min(
    text.length,
    TAB_COMPLETION_CANDIDATE_SEPARATOR.length - 1,
  )
  for (let length = maxPrefixLength; length > 0; length--) {
    if (text.endsWith(TAB_COMPLETION_CANDIDATE_SEPARATOR.slice(0, length))) {
      return text.slice(0, -length)
    }
  }
  return text
}

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

const TAB_COMPLETION_LENGTH_CONSTRAINTS: Record<
  TabCompletionLengthPreset,
  string
> = {
  short:
    'Keep the completion short (about 1-2 sentences, roughly 40-120 characters). Avoid starting a new section.',
  medium:
    'Keep the completion medium length (about 2-5 sentences, roughly 120-300 characters).',
  long: 'Prefer a longer continuation (multiple sentences or paragraphs, roughly 300-800 characters) when appropriate.',
}

const buildTabCompletionConstraints = (
  preset: TabCompletionLengthPreset,
  customConstraints: string,
): string => {
  const presetConstraint = TAB_COMPLETION_LENGTH_CONSTRAINTS[preset] ?? ''
  const trimmedCustom = customConstraints.trim()
  return [presetConstraint, trimmedCustom].filter(Boolean).join('\n')
}

const extractMaskedContext = (
  doc: Text,
  cursorOffset: number,
  maxBeforeChars: number,
  maxAfterChars: number,
): { before: string; after: string } => {
  const beforeStart = Math.max(0, cursorOffset - maxBeforeChars)
  const before = doc.sliceString(beforeStart, cursorOffset)

  if (maxAfterChars <= 0) {
    return { before, after: '' }
  }

  const afterEnd = Math.min(doc.length, cursorOffset + maxAfterChars)
  const after = doc.sliceString(cursorOffset, afterEnd)

  return { before, after }
}

const buildTabCompletionUserMessage = (
  fileTitle: string,
  before: string,
  after: string,
  textToReplace: string | null,
): string => {
  const titleSection = fileTitle ? `File title:\n${fileTitle}\n\n` : ''
  if (textToReplace !== null) {
    return (
      titleSection +
      'This is an inline replacement request. The content inside <text_to_replace> will be replaced by your output. Return only the replacement text.\n\n' +
      'The final document text will be <text_before_cursor> with <text_to_replace> replaced by your output, followed by <text_after_cursor>.\n\n' +
      `<text_before_cursor>\n${before}\n</text_before_cursor>\n` +
      `<text_to_replace>\n${textToReplace}\n</text_to_replace>\n` +
      `<text_after_cursor>\n${after}\n</text_after_cursor>`
    )
  }
  return (
    titleSection +
    'This is an inline completion request. The <mask/> is the cursor position between <text_before_cursor> and <text_after_cursor>.\n' +
    'The final document text will be: <text_before_cursor> + your output + <text_after_cursor>.\n' +
    'Continue exactly from the end of <text_before_cursor>. Return only the text to insert at <mask/>.\n\n' +
    `<text_before_cursor>\n${before}\n</text_before_cursor>\n` +
    `${MASK_TAG}\n` +
    `<text_after_cursor>\n${after}\n</text_after_cursor>`
  )
}

export class TabCompletionController {
  private tabCompletionTimer: ReturnType<typeof setTimeout> | null = null
  private tabCompletionAbortController: AbortController | null = null
  private tabCompletionSuggestion: TabCompletionSuggestion | null = null
  private tabCompletionPending: {
    editor: Editor
    cursorOffset: number
    replaceFromOffset: number | null
  } | null = null
  private tabLoadingView: EditorView | null = null
  private lastAutoTriggerAt = 0

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

    return {
      ...merged,
      maxBeforeChars,
      maxAfterChars,
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

  private getTriggerMatch(
    view: EditorView,
    cursorOffset: number,
  ): { replaceFromOffset: number | null } | null {
    const triggers = this.getTabCompletionTriggers().filter(
      (trigger) => trigger.enabled,
    )
    if (triggers.length === 0) return null

    const doc = view.state.doc
    const windowSize = Math.min(
      this.getTabCompletionOptions().contextRange,
      2000,
    )
    const beforeWindowStart = Math.max(0, cursorOffset - windowSize)
    const beforeWindow = doc.sliceString(beforeWindowStart, cursorOffset)
    const beforeWindowTrimmed = beforeWindow.replace(/\s+$/, '')

    for (const trigger of triggers) {
      if (!trigger.pattern || trigger.pattern.trim().length === 0) {
        continue
      }
      if (trigger.type === 'string') {
        if (beforeWindow.endsWith(trigger.pattern)) {
          return {
            replaceFromOffset:
              trigger.acceptMode === 'replace'
                ? cursorOffset - trigger.pattern.length
                : null,
          }
        }
        if (
          trigger.acceptMode !== 'replace' &&
          beforeWindowTrimmed.endsWith(trigger.pattern)
        ) {
          return { replaceFromOffset: null }
        }
        continue
      }
      try {
        const regex = new RegExp(trigger.pattern)
        const match = regex.exec(beforeWindow)
        if (match) {
          const matchEndsAtCursor =
            match.index + match[0].length === beforeWindow.length
          if (trigger.acceptMode === 'replace' && !matchEndsAtCursor) {
            continue
          }
          return {
            replaceFromOffset:
              trigger.acceptMode === 'replace'
                ? beforeWindowStart + match.index
                : null,
          }
        }
        if (
          trigger.acceptMode !== 'replace' &&
          regex.test(beforeWindowTrimmed)
        ) {
          return { replaceFromOffset: null }
        }
      } catch {
        // Ignore invalid regex patterns.
      }
    }
    return null
  }

  private showLoadingDots(view: EditorView, from: number) {
    this.tabLoadingView = view
    this.deps.showTabLoadingDots(view, from)
  }

  private hideLoadingDots() {
    if (!this.tabLoadingView) return
    this.deps.hideTabLoadingDots(this.tabLoadingView)
    this.tabLoadingView = null
  }

  clearTimer() {
    if (this.tabCompletionTimer) {
      clearTimeout(this.tabCompletionTimer)
      this.tabCompletionTimer = null
    }
    this.tabCompletionPending = null
  }

  cancelRequest() {
    this.hideLoadingDots()
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
    this.hideLoadingDots()
    if (this.tabCompletionSuggestion) {
      const { multipleCandidates, view } = this.tabCompletionSuggestion
      if (view) {
        if (multipleCandidates) {
          this.deps.setTabCompletionDisplay(view, null)
        } else {
          this.deps.setInlineSuggestionGhost(view, null)
        }
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
    const options = this.getTabCompletionOptions()
    const triggerMatch = this.getTriggerMatch(view, cursorOffset)
    if (!triggerMatch && !options.idleTriggerEnabled) return
    const isAutoTrigger = !triggerMatch && options.idleTriggerEnabled
    const delay = Math.max(
      0,
      isAutoTrigger ? options.autoTriggerDelayMs : options.triggerDelayMs,
    )
    if (isAutoTrigger) {
      const cooldownMs = Math.max(0, options.autoTriggerCooldownMs)
      if (cooldownMs > 0 && Date.now() - this.lastAutoTriggerAt < cooldownMs) {
        return
      }
    }
    this.tabCompletionPending = {
      editor,
      cursorOffset,
      replaceFromOffset: triggerMatch?.replaceFromOffset ?? null,
    }
    this.tabCompletionTimer = setTimeout(() => {
      if (!this.tabCompletionPending) return
      if (this.tabCompletionPending.editor !== editor) return
      const currentView = this.deps.getEditorView(editor)
      if (!currentView) return
      if (currentView.state.selection.main.head !== cursorOffset) return
      const currentSelection = editor.getSelection()
      if (currentSelection && currentSelection.length > 0) return
      if (this.deps.isContinuationInProgress()) return
      if (isAutoTrigger) {
        const cooldownMs = Math.max(0, options.autoTriggerCooldownMs)
        if (
          cooldownMs > 0 &&
          Date.now() - this.lastAutoTriggerAt < cooldownMs
        ) {
          return
        }
        this.lastAutoTriggerAt = Date.now()
      }
      void this.run(
        editor,
        cursorOffset,
        this.tabCompletionPending.replaceFromOffset,
      )
    }, delay)
  }

  private cleanCandidateText(text: string): string {
    let cleaned = text.replace(/\r\n/g, '\n').replace(/\s+$/, '')
    if (!cleaned.trim() || /^[\s\n\t]+$/.test(cleaned)) return ''
    cleaned = cleaned.replace(/^[\s\n\t]+/, '')
    return cleaned
  }

  private renderSuggestion(suggestion: TabCompletionSuggestion) {
    if (this.tabCompletionSuggestion !== suggestion) return

    const selected = suggestion.candidates[suggestion.selectedIndex]
    const availableCount = suggestion.candidates.filter(
      (candidate) => candidate.text.length > 0,
    ).length

    if (suggestion.multipleCandidates) {
      this.deps.setTabCompletionDisplay(suggestion.view, {
        from: suggestion.cursorOffset,
        text: selected?.text ?? '',
        candidateStatuses: suggestion.candidates.map(
          (candidate) => candidate.status,
        ),
        selectedIndex: suggestion.selectedIndex,
        showSelectionIndicator: suggestion.hasUserNavigated,
        availableCount,
        switchHint: this.deps.getSwitchSuggestionHint(),
      })
    } else if (selected?.text) {
      this.hideLoadingDots()
      this.deps.setInlineSuggestionGhost(suggestion.view, {
        from: suggestion.cursorOffset,
        text: selected.text,
      })
    } else if (selected?.status === 'generating') {
      this.showLoadingDots(suggestion.view, suggestion.cursorOffset)
    } else {
      this.hideLoadingDots()
    }

    if (!selected?.text) {
      this.deps.setActiveInlineSuggestion(null)
      return
    }
    this.deps.setActiveInlineSuggestion({
      source: 'tab',
      editor: suggestion.editor,
      view: suggestion.view,
      fromOffset: suggestion.cursorOffset,
      text: selected.text,
    })
  }

  private updateCandidatesFromRawText(
    suggestion: TabCompletionSuggestion,
    rawText: string,
  ) {
    const rawCandidates = rawText
      .split(TAB_COMPLETION_CANDIDATE_SEPARATOR)
      .slice(0, suggestion.candidates.length)
    const completedCount = Math.min(
      rawCandidates.length - 1,
      suggestion.candidates.length - 1,
    )

    suggestion.candidates.forEach((candidate, index) => {
      const rawCandidate = rawCandidates[index]
      if (rawCandidate === undefined) {
        candidate.text = ''
        candidate.status = 'pending'
        return
      }
      const displayText =
        index === rawCandidates.length - 1
          ? trimPartialSeparator(rawCandidate)
          : rawCandidate
      candidate.text = this.cleanCandidateText(displayText)
      candidate.status = index < completedCount ? 'complete' : 'generating'
    })

    this.renderSuggestion(suggestion)
  }

  private finishCandidateGeneration(
    suggestion: TabCompletionSuggestion,
    interrupted: boolean,
  ) {
    if (this.tabCompletionSuggestion !== suggestion) return
    suggestion.candidates.forEach((candidate) => {
      if (candidate.status === 'generating') {
        candidate.status =
          !interrupted && candidate.text ? 'complete' : 'interrupted'
        return
      }
      if (candidate.status === 'pending') {
        candidate.status = 'interrupted'
      }
    })
    this.renderSuggestion(suggestion)
  }

  tryNavigateFromView(view: EditorView, direction: -1 | 1): boolean {
    const suggestion = this.tabCompletionSuggestion
    if (!suggestion || suggestion.view !== view) return false
    if (!suggestion.multipleCandidates) return false

    const availableIndices = suggestion.candidates.flatMap(
      (candidate, index) => (candidate.text ? [index] : []),
    )
    if (availableIndices.length <= 1) return true

    const currentPosition = availableIndices.indexOf(suggestion.selectedIndex)
    const normalizedPosition = currentPosition >= 0 ? currentPosition : 0
    const nextPosition =
      (normalizedPosition + direction + availableIndices.length) %
      availableIndices.length
    suggestion.selectedIndex = availableIndices[nextPosition]
    suggestion.hasUserNavigated = true
    this.renderSuggestion(suggestion)
    return true
  }

  tryRejectFromView(view: EditorView): boolean {
    const suggestion = this.tabCompletionSuggestion
    if (!suggestion || suggestion.view !== view) return false
    this.cancelRequest()
    this.deps.clearInlineSuggestion()
    return true
  }

  handleSelectionChange(view: EditorView) {
    const suggestion = this.tabCompletionSuggestion
    if (!suggestion || suggestion.view !== view) return
    if (view.state.selection.main.head === suggestion.cursorOffset) return
    this.cancelRequest()
    this.deps.clearInlineSuggestion()
  }

  async run(
    editor: Editor,
    scheduledCursorOffset: number,
    replaceFromOffset?: number | null,
  ) {
    let hasShownValidSuggestion = false
    try {
      const settings = this.deps.getSettings()
      if (!settings.continuationOptions?.enableTabCompletion) return
      if (this.deps.isContinuationInProgress()) return

      const view = this.deps.getEditorView(editor)
      if (!view) return
      if (view.state.selection.main.head !== scheduledCursorOffset) return
      const selection = editor.getSelection()
      if (selection && selection.length > 0) return
      const effectiveReplaceFromOffset =
        replaceFromOffset === undefined
          ? (this.getTriggerMatch(view, scheduledCursorOffset)
              ?.replaceFromOffset ?? null)
          : replaceFromOffset

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
      const textToReplace =
        effectiveReplaceFromOffset !== null
          ? doc.sliceString(effectiveReplaceFromOffset, scheduledCursorOffset)
          : null
      const beforeLength = before.trim().length
      if (!before || beforeLength === 0) return
      if (beforeWindowLength < TAB_COMPLETION_MIN_CONTEXT_LENGTH) return

      let modelId = settings.continuationOptions?.tabCompletionModelId
      if (!modelId || modelId.length === 0) {
        modelId = settings.continuationOptions?.continuationModelId
      }
      if (!modelId) return

      const sidebarOverrides = this.deps.getActiveConversationOverrides()
      const { topP } = this.deps.resolveContinuationParams(sidebarOverrides)

      const { providerClient, model } = getChatModelClient({
        settings,
        modelId,
        onAutoPromoteTransportMode: (providerId, mode) => {
          void promoteProviderTransportModeToObsidian({
            getSettings: this.deps.getSettings,
            setSettings: this.deps.setSettings,
            providerId,
            mode,
          })
        },
      })

      const fileTitle = this.deps.getActiveFileTitle()
      const baseSystemPrompt =
        settings.continuationOptions?.tabCompletionSystemPrompt ??
        DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT
      const tabCompletionConstraints =
        settings.continuationOptions?.tabCompletionConstraints ?? ''
      const tabCompletionLengthPreset =
        settings.continuationOptions?.tabCompletionLengthPreset ??
        DEFAULT_TAB_COMPLETION_LENGTH_PRESET
      const combinedConstraints = buildTabCompletionConstraints(
        tabCompletionLengthPreset,
        tabCompletionConstraints,
      )
      const basePrompt = applyTabCompletionConstraints(
        baseSystemPrompt,
        combinedConstraints,
      )
      const multipleCandidatesEnabled = true
      const systemPrompt = multipleCandidatesEnabled
        ? `${basePrompt}\n\n${TAB_COMPLETION_MULTIPLE_CANDIDATES_CONSTRAINT}`
        : basePrompt

      const requestMessages: RequestMessage[] = [
        {
          role: 'system' as const,
          content: systemPrompt,
        },
        {
          role: 'user' as const,
          content: buildTabCompletionUserMessage(
            fileTitle,
            before,
            after,
            textToReplace,
          ),
        },
      ]

      this.cancelRequest()
      this.deps.clearInlineSuggestion()
      this.tabCompletionPending = null

      const suggestion: TabCompletionSuggestion = {
        editor,
        view,
        cursorOffset: scheduledCursorOffset,
        replaceFromOffset: effectiveReplaceFromOffset,
        candidates: Array.from(
          {
            length: multipleCandidatesEnabled
              ? TAB_COMPLETION_CANDIDATE_COUNT
              : 1,
          },
          (_, index) => ({
            text: '',
            status: index === 0 ? 'generating' : 'pending',
          }),
        ),
        selectedIndex: 0,
        hasUserNavigated: false,
        multipleCandidates: multipleCandidatesEnabled,
      }
      this.tabCompletionSuggestion = suggestion
      this.renderSuggestion(suggestion)

      const baseRequest: LLMRequestBase = {
        model: model.model,
        messages: requestMessages,
        // Tab 补全是延迟敏感场景，默认 'off'；用户可在设置中改为 'low'/'auto' 以适配强制推理的模型
        reasoningLevel: options.reasoningLevel,
      }
      if (typeof topP === 'number') {
        baseRequest.top_p = topP
      }
      const requestTimeout = Math.max(0, options.requestTimeoutMs)
      const attempts = Math.max(0, Math.floor(options.maxRetries)) + 1

      for (let attempt = 0; attempt < attempts; attempt++) {
        const controller = new AbortController()
        this.tabCompletionAbortController = controller
        this.deps.addAbortController(controller)

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null
        if (requestTimeout > 0) {
          timeoutHandle = setTimeout(() => controller.abort(), requestTimeout)
        }

        try {
          let rawText = ''
          let requestInvalidated = false
          try {
            const result = await executeSingleTurn({
              providerClient,
              model,
              request: baseRequest,
              deliveryMode: 'incremental',
              purpose: 'lightweight',
              signal: controller.signal,
              onStreamDelta: ({ contentDelta }) => {
                if (!contentDelta) return
                rawText += contentDelta

                const currentView = this.deps.getEditorView(editor)
                if (
                  !currentView ||
                  currentView !== suggestion.view ||
                  currentView.state.selection.main.head !==
                    scheduledCursorOffset ||
                  editor.getSelection()?.length
                ) {
                  requestInvalidated = true
                  controller.abort()
                  return
                }

                if (!rawText.trim()) return
                this.updateCandidatesFromRawText(suggestion, rawText)
                hasShownValidSuggestion = suggestion.candidates.some(
                  (candidate) => candidate.text.length > 0,
                )
              },
            })

            if (requestInvalidated) return

            const finalText = result.content || rawText
            if (finalText.length === 0) {
              this.finishCandidateGeneration(suggestion, true)
              return
            }

            const currentView = this.deps.getEditorView(editor)
            if (!currentView) return
            if (currentView !== suggestion.view) return
            if (currentView.state.selection.main.head !== scheduledCursorOffset)
              return
            if (editor.getSelection()?.length) return

            this.updateCandidatesFromRawText(suggestion, finalText)
            this.finishCandidateGeneration(suggestion, false)
            if (timeoutHandle) clearTimeout(timeoutHandle)
            return
          } catch (error) {
            if (requestInvalidated) return
            throw error
          }
        } catch (error) {
          if (timeoutHandle) clearTimeout(timeoutHandle)

          const aborted =
            controller.signal.aborted || error?.name === 'AbortError'
          if (
            attempt < attempts - 1 &&
            aborted &&
            !hasShownValidSuggestion &&
            !isRequestErrorNonRetryable(error)
          ) {
            this.deps.removeAbortController(controller)
            this.tabCompletionAbortController = null
            continue
          }
          if (error?.name === 'AbortError') {
            this.finishCandidateGeneration(suggestion, true)
            return
          }
          console.error('Tab completion failed:', error)
          this.finishCandidateGeneration(suggestion, true)
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

    const selectedCandidate = suggestion.candidates[suggestion.selectedIndex]
    if (!selectedCandidate?.text) return false

    const cursor = editor.getCursor()
    const replaceFrom =
      suggestion.replaceFromOffset !== null
        ? editor.offsetToPos(suggestion.replaceFromOffset)
        : cursor
    const suggestionText = escapeMarkdownSpecialChars(selectedCandidate.text, {
      escapeAngleBrackets: true,
      preserveCodeBlocks: true,
    })
    this.cancelRequest()
    this.deps.clearInlineSuggestion()
    editor.replaceRange(suggestionText, replaceFrom, cursor)

    const parts = suggestionText.split('\n')
    const endCursor =
      parts.length === 1
        ? { line: replaceFrom.line, ch: replaceFrom.ch + parts[0].length }
        : {
            line: replaceFrom.line + parts.length - 1,
            ch: parts[parts.length - 1].length,
          }
    editor.setCursor(endCursor)
    return true
  }
}
