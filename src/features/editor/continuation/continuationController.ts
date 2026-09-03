import type { EditorView } from '@codemirror/view'
import { App, Editor, Notice, TFile, TFolder } from 'obsidian'

import { executeSingleTurn } from '../../../core/ai/single-turn'
import type { getChatModelClient } from '../../../core/llm/manager'
import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { ConversationOverrideSettings } from '../../../types/conversation-settings.types'
import type { LLMRequestBase, RequestMessage } from '../../../types/llm/request'
import type {
  MentionableFile,
  MentionableFolder,
} from '../../../types/mentionable'
import { getNestedFiles, readMultipleTFiles } from '../../../utils/obsidian'

// Structural task contract for continuation generation. Always injected,
// regardless of the user's configured chat persona (settings.systemPrompt) —
// this is not a style preference, it's what keeps a chat-tuned model from
// responding conversationally to a bare block of document text. Not exposed
// as a setting, mirroring how tab completion's own base system prompt isn't
// user-editable either; the instruction box and continuation presets are the
// user-facing customization surface.
const CONTINUATION_TASK_CONTRACT =
  "You are continuing the user's writing directly inside their document. " +
  'Your output will be inserted verbatim at the point where the given context ends.\n\n' +
  'Rules:\n' +
  '- Continue seamlessly from the exact end of the context in <context_to_continue> — do not repeat, rephrase, or summarize any of it.\n' +
  '- If an instruction is given below, treat it as a directive for what the continuation should contain or how it should be shaped, not as a question to answer conversationally.\n' +
  '- Match the existing language, tone, register, and formatting (headings, lists, emphasis, etc.) of the context, unless the instruction says otherwise.\n' +
  '- Content inside <reference_rules>, if present, is a binding style/content constraint you must follow.\n' +
  '- Content inside <mentioned_files>, if present, is supplementary background material you may draw on — do not copy it verbatim into the output.\n' +
  '- Output only the continuation text itself: no preamble, no explanations, no meta-commentary, no code fences or quotation wrapping, no restating the instruction or title.\n' +
  '- End at a natural stopping point (end of a sentence, thought, or paragraph) rather than trailing off mid-sentence.'

// The provider/model pair the caller has already resolved (e.g. Quick Ask's
// "continue" mode reuses the same providerClient/model as its ask/agent
// path). Continuation always runs with an explicit model — there is no
// implicit "continuation model" fallback here.
export type ContinuationModelOverride = ReturnType<typeof getChatModelClient>

type ContinuationControllerDeps = {
  app: App
  getSettings: () => YoloSettings
  setSettings: (newSettings: YoloSettings) => Promise<boolean>
  t: (key: string, fallback?: string) => string
  getActiveConversationOverrides: () => ConversationOverrideSettings | undefined
  resolveContinuationParams: (overrides?: ConversationOverrideSettings) => {
    temperature?: number
    topP?: number
    stream: boolean
  }
  getEditorView: (editor: Editor) => EditorView | null
  registerTimeout: (callback: () => void, timeout: number) => void
  addAbortController: (controller: AbortController) => void
  removeAbortController: (controller: AbortController) => void
  setContinuationInProgress: (value: boolean) => void
  cancelAllAiTasks: () => void
  clearInlineSuggestion: () => void
  setInlineSuggestionGhost: (
    view: EditorView,
    payload: { from: number; text: string } | null,
  ) => void
  showThinkingIndicator: (
    view: EditorView,
    from: number,
    label: string,
    snippet?: string,
  ) => void
  hideThinkingIndicator: (view: EditorView) => void
  setContinuationSuggestion: (params: {
    editor: Editor
    view: EditorView
    text: string
    fromOffset: number
    startPos: ReturnType<Editor['getCursor']>
  }) => void
}

export class ContinuationController {
  private readonly deps: ContinuationControllerDeps

  constructor(deps: ContinuationControllerDeps) {
    this.deps = deps
  }

  async handleContinueWriting(
    editor: Editor,
    customPrompt: string | undefined,
    mentionables: (MentionableFile | MentionableFolder)[] | undefined,
    modelOverride: ContinuationModelOverride,
  ) {
    this.deps.cancelAllAiTasks()
    this.deps.clearInlineSuggestion()

    const controller = new AbortController()
    this.deps.addAbortController(controller)
    let view: EditorView | null = null

    try {
      const notice = new Notice('Generating continuation...', 0)
      const cursor = editor.getCursor()
      const selected = editor.getSelection()
      const headText = editor.getRange({ line: 0, ch: 0 }, cursor)

      const hasSelection = !!selected && selected.trim().length > 0
      const baseContext = hasSelection ? selected : headText
      const fallbackInstruction = (customPrompt ?? '').trim()
      const fileTitleCandidate =
        this.deps.app.workspace.getActiveFile()?.basename?.trim() ?? ''

      if (!baseContext || baseContext.trim().length === 0) {
        if (!fallbackInstruction && !fileTitleCandidate) {
          notice.setMessage('No preceding content to continue.')
          this.deps.registerTimeout(() => notice.hide(), 1000)
          return
        }
      }

      const settings = this.deps.getSettings()
      const referenceRuleFolders =
        settings.continuationOptions?.referenceRuleFolders ??
        settings.continuationOptions?.manualContextFolders ??
        []

      let referenceRulesSection = ''
      if (referenceRuleFolders.length > 0) {
        try {
          const referenceFilesMap = new Map<string, TFile>()
          const isSupportedReferenceFile = (file: TFile) => {
            const ext = file.extension?.toLowerCase?.() ?? ''
            return ext === 'md' || ext === 'markdown' || ext === 'txt'
          }

          for (const rawPath of referenceRuleFolders) {
            const folderPath = rawPath.trim()
            if (!folderPath) continue
            const abstract =
              this.deps.app.vault.getAbstractFileByPath(folderPath)
            if (abstract instanceof TFolder) {
              for (const file of getNestedFiles(
                abstract,
                this.deps.app.vault,
              )) {
                if (isSupportedReferenceFile(file)) {
                  referenceFilesMap.set(file.path, file)
                }
              }
            } else if (abstract instanceof TFile) {
              if (isSupportedReferenceFile(abstract)) {
                referenceFilesMap.set(abstract.path, abstract)
              }
            }
          }

          const referenceFiles = Array.from(referenceFilesMap.values())
          if (referenceFiles.length > 0) {
            const referenceContents = await readMultipleTFiles(
              referenceFiles,
              this.deps.app.vault,
            )
            const blocks = referenceFiles.map((file, index) => {
              const content = referenceContents[index] ?? ''
              return `File: ${file.path}\n${content}`
            })
            const combinedReference = blocks.join('\n\n')
            if (combinedReference.trim().length > 0) {
              referenceRulesSection = `<reference_rules>\n${combinedReference}\n</reference_rules>\n\n`
            }
          }
        } catch (error) {
          console.warn(
            'Failed to load reference rule folders for continuation',
            error,
          )
        }
      }

      let mentionableContextSection = ''
      if (mentionables && mentionables.length > 0) {
        try {
          const fileMap = new Map<string, TFile>()
          for (const mentionable of mentionables) {
            if (mentionable.type === 'file') {
              fileMap.set(mentionable.file.path, mentionable.file)
            } else if (mentionable.type === 'folder') {
              for (const file of getNestedFiles(
                mentionable.folder,
                this.deps.app.vault,
              )) {
                fileMap.set(file.path, file)
              }
            }
          }
          const files = Array.from(fileMap.values())
          if (files.length > 0) {
            const contents = await readMultipleTFiles(
              files,
              this.deps.app.vault,
            )
            const combined = files
              .map((file, index) => {
                const content = contents[index] ?? ''
                return `File: ${file.path}\n${content}`
              })
              .join('\n\n')
            if (combined.trim().length > 0) {
              mentionableContextSection = `<mentioned_files>\n${combined}\n</mentioned_files>\n\n`
            }
          }
        } catch (error) {
          console.warn(
            'Failed to include mentioned files for continuation',
            error,
          )
        }
      }

      const continuationCharLimit = Math.max(
        0,
        settings.continuationOptions?.maxContinuationChars ?? 8000,
      )
      const limitedContext =
        continuationCharLimit > 0 && baseContext.length > continuationCharLimit
          ? baseContext.slice(-continuationCharLimit)
          : continuationCharLimit === 0
            ? ''
            : baseContext

      const sidebarOverrides = this.deps.getActiveConversationOverrides()
      const {
        temperature,
        topP,
        stream: streamPreference,
      } = this.deps.resolveContinuationParams(sidebarOverrides)

      const { providerClient, model } = modelOverride

      const userInstruction = (customPrompt ?? '').trim()
      const instructionSection = userInstruction
        ? `Instruction for this continuation:\n${userInstruction}\n\n`
        : ''

      // The user's chat persona is secondary voice/tone guidance layered
      // under the structural task contract above — never a replacement
      // for it, since an unrelated persona (e.g. "ask clarifying
      // questions first") must not override the continuation contract.
      const personaPrompt = (settings.systemPrompt ?? '').trim()
      const systemPrompt = personaPrompt
        ? `${CONTINUATION_TASK_CONTRACT}\n\nAdditional voice/persona guidance from the user (secondary to the rules above):\n${personaPrompt}`
        : CONTINUATION_TASK_CONTRACT

      const activeFileForTitle = this.deps.app.workspace.getActiveFile()
      const fileTitle = activeFileForTitle?.basename?.trim() ?? ''
      const titleLine = fileTitle ? `File title: ${fileTitle}\n\n` : ''
      const hasContext = (baseContext ?? '').trim().length > 0

      if (controller.signal.aborted) {
        return
      }

      const limitedContextHasContent = limitedContext.trim().length > 0
      const contextSection =
        hasContext && limitedContextHasContent
          ? `<context_to_continue>\n${limitedContext}\n</context_to_continue>\n\n`
          : ''
      const combinedContextSection = `${referenceRulesSection}${mentionableContextSection}${contextSection}`

      // Always end on an explicit trigger cue — a chat-tuned model left
      // with nothing but a trailing block of document text (the common
      // case: no instruction) tends to respond to it conversationally
      // instead of continuing it.
      const generationCue = limitedContextHasContent
        ? 'Continue writing directly from the end of <context_to_continue>.'
        : userInstruction
          ? 'Write according to the instruction above.'
          : 'Begin writing new content based on the file title above.'

      const requestMessages: RequestMessage[] = [
        {
          role: 'system' as const,
          content: systemPrompt,
        },
        {
          role: 'user' as const,
          content: `${titleLine}${instructionSection}${combinedContextSection}${generationCue}`,
        },
      ]

      this.deps.setContinuationInProgress(true)

      view = this.deps.getEditorView(editor)
      if (!view) {
        notice.setMessage('Unable to access editor view.')
        this.deps.registerTimeout(() => notice.hide(), 1200)
        return
      }

      // Ensure editor is focused so inline widgets render at the active cursor
      view.focus()

      const selection = view.state.selection.main
      const selectionHeadOffset = selection.head
      const selectionEndOffset = Math.max(selection.head, selection.anchor)
      const currentCursor = editor.offsetToPos(selectionHeadOffset)
      const cursorOffset = selectionHeadOffset
      const thinkingText = this.deps.t(
        'chat.customContinueProcessing',
        'Thinking',
      )
      this.deps.showThinkingIndicator(view, cursorOffset, thinkingText)

      const baseRequest: LLMRequestBase = {
        model: model.model,
        messages: requestMessages,
      }
      if (typeof temperature === 'number') {
        baseRequest.temperature = temperature
      }
      if (typeof topP === 'number') {
        baseRequest.top_p = topP
      }

      console.debug('Continuation request params', {
        overrides: sidebarOverrides,
        request: baseRequest,
        streamPreference,
      })

      const insertStart = hasSelection
        ? editor.offsetToPos(selectionEndOffset)
        : currentCursor
      if (hasSelection) {
        editor.setCursor(insertStart)
      }
      const startOffset = hasSelection
        ? selectionEndOffset
        : selectionHeadOffset
      let suggestionText = ''
      let hasHiddenThinkingIndicator = false
      const nonNullView = view
      let reasoningPreviewBuffer = ''
      let lastReasoningPreview = ''
      const MAX_REASONING_BUFFER = 400

      const formatReasoningPreview = (text: string) => {
        const normalized = text.replace(/\s+/g, ' ').trim()
        if (!normalized) return ''
        if (normalized.length <= 120) {
          return normalized
        }
        return normalized.slice(-120)
      }

      const updateThinkingReasoningPreview = () => {
        if (hasHiddenThinkingIndicator) return
        const preview = formatReasoningPreview(reasoningPreviewBuffer)
        if (!preview || preview === lastReasoningPreview) {
          return
        }
        lastReasoningPreview = preview
        this.deps.showThinkingIndicator(
          nonNullView,
          cursorOffset,
          thinkingText,
          preview,
        )
      }

      const updateContinuationSuggestion = (text: string) => {
        if (!hasHiddenThinkingIndicator) {
          this.deps.hideThinkingIndicator(nonNullView)
          hasHiddenThinkingIndicator = true
        }
        this.deps.setInlineSuggestionGhost(nonNullView, {
          from: startOffset,
          text,
        })
        this.deps.setContinuationSuggestion({
          editor,
          view: nonNullView,
          text,
          fromOffset: startOffset,
          startPos: insertStart,
        })
      }

      const continuationResult = await executeSingleTurn({
        providerClient,
        model,
        request: baseRequest,
        signal: controller.signal,
        deliveryMode: streamPreference ? 'incremental' : 'buffered',
        primaryRequestTimeoutMs:
          settings.continuationOptions.primaryRequestTimeoutMs,
        streamFallbackRecoveryEnabled:
          settings.continuationOptions.streamFallbackRecoveryEnabled,
        onStreamDelta: ({ contentDelta, reasoningDelta }) => {
          if (reasoningDelta) {
            reasoningPreviewBuffer += reasoningDelta
            if (reasoningPreviewBuffer.length > MAX_REASONING_BUFFER) {
              reasoningPreviewBuffer =
                reasoningPreviewBuffer.slice(-MAX_REASONING_BUFFER)
            }
            updateThinkingReasoningPreview()
          }
          if (!contentDelta) return

          suggestionText += contentDelta
          updateContinuationSuggestion(suggestionText)
        },
      })

      if (!suggestionText && continuationResult.content) {
        suggestionText = continuationResult.content
        updateContinuationSuggestion(suggestionText)
      }

      if (suggestionText.trim().length > 0) {
        notice.setMessage('Continuation suggestion ready. Press Tab to accept.')
      } else {
        this.deps.clearInlineSuggestion()
        notice.setMessage('No continuation generated.')
      }
      this.deps.registerTimeout(() => notice.hide(), 1200)
    } catch (error) {
      this.deps.clearInlineSuggestion()
      if ((error as Error)?.name === 'AbortError') {
        const n = new Notice('已取消生成。')
        this.deps.registerTimeout(() => n.hide(), 1000)
      } else {
        console.error(error)
        new Notice('Failed to generate continuation.')
      }
    } finally {
      if (view) {
        this.deps.hideThinkingIndicator(view)
      }
      this.deps.setContinuationInProgress(false)
      this.deps.removeAbortController(controller)
    }
  }
}
