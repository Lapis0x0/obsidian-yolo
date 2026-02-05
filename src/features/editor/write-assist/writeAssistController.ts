import type { EditorView } from '@codemirror/view'
import { App, Editor, Notice, TFile, TFolder } from 'obsidian'

import { getChatModelClient } from '../../../core/llm/manager'
import type { RAGEngine } from '../../../core/rag/ragEngine'
import type { SmartComposerSettings } from '../../../settings/schema/setting.types'
import type { ApplyViewState } from '../../../types/apply-view.types'
import type { ConversationOverrideSettings } from '../../../types/conversation-settings.types'
import type { LLMRequestBase, RequestMessage } from '../../../types/llm/request'
import type {
  MentionableFile,
  MentionableFolder,
} from '../../../types/mentionable'
import {
  getNestedFiles,
  readMultipleTFiles,
  readTFileContent,
} from '../../../utils/obsidian'

type WriteAssistDeps = {
  app: App
  getSettings: () => SmartComposerSettings
  t: (key: string, fallback?: string) => string
  getActiveConversationOverrides: () => ConversationOverrideSettings | undefined
  resolveContinuationParams: (overrides?: ConversationOverrideSettings) => {
    temperature?: number
    topP?: number
    stream: boolean
    useVaultSearch: boolean
  }
  getRagEngine: () => Promise<RAGEngine>
  getEditorView: (editor: Editor) => EditorView | null
  closeSmartSpace: () => void
  registerTimeout: (callback: () => void, timeout: number) => void
  addAbortController: (controller: AbortController) => void
  removeAbortController: (controller: AbortController) => void
  setContinuationInProgress: (value: boolean) => void
  cancelAllAiTasks: () => void
  clearInlineSuggestion: () => void
  ensureInlineSuggestionExtension: (view: EditorView) => void
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
  openApplyReview: (state: ApplyViewState) => Promise<void>
}

const FIRST_TOKEN_TIMEOUT_MS = 12000

export class WriteAssistController {
  private readonly deps: WriteAssistDeps

  constructor(deps: WriteAssistDeps) {
    this.deps = deps
  }

  async handleCustomRewrite(
    editor: Editor,
    customPrompt?: string,
    preSelectedText?: string,
    preSelectionFrom?: { line: number; ch: number },
  ) {
    const selected = preSelectedText ?? editor.getSelection()
    if (!selected || selected.trim().length === 0) {
      new Notice('请先选择要改写的文本。')
      return
    }

    const from = preSelectionFrom ?? editor.getCursor('from')

    const notice = new Notice('正在生成改写...', 0)
    const controller = new AbortController()
    this.deps.addAbortController(controller)

    try {
      const sidebarOverrides = this.deps.getActiveConversationOverrides()
      const {
        temperature,
        topP,
        stream: streamPreference,
      } = this.deps.resolveContinuationParams(sidebarOverrides)

      const settings = this.deps.getSettings()
      const rewriteModelId =
        settings.continuationOptions?.continuationModelId ??
        settings.chatModelId

      const { providerClient, model } = getChatModelClient({
        settings,
        modelId: rewriteModelId,
      })

      const systemPrompt =
        'You are an intelligent assistant that rewrites ONLY the provided markdown text according to the instruction. Preserve the original meaning, structure, and any markdown (links, emphasis, code) unless explicitly told otherwise. Output ONLY the rewritten text without code fences or extra explanations.'

      const instruction = (customPrompt ?? '').trim()
      const isBaseModel = Boolean(model.isBaseModel)
      const baseModelSpecialPrompt = (
        settings.chatOptions.baseModelSpecialPrompt ?? ''
      ).trim()
      const basePromptSection =
        isBaseModel && baseModelSpecialPrompt.length > 0
          ? `${baseModelSpecialPrompt}\n\n`
          : ''
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
          content: `${basePromptSection}Instruction:\n${instruction}\n\nSelected text:\n${selected}\n\nRewrite the selected text accordingly. Output only the rewritten text.`,
        },
      ]

      const rewriteRequestBase: LLMRequestBase = {
        model: model.model,
        messages: requestMessages,
      }
      if (typeof temperature === 'number') {
        rewriteRequestBase.temperature = temperature
      }
      if (typeof topP === 'number') {
        rewriteRequestBase.top_p = topP
      }

      const stripFences = (s: string) => {
        const lines = (s ?? '').split('\n')
        if (lines.length > 0 && lines[0].startsWith('```')) lines.shift()
        if (lines.length > 0 && lines[lines.length - 1].startsWith('```'))
          lines.pop()
        return lines.join('\n')
      }

      let rewritten = ''
      if (streamPreference) {
        const streamIterator = await providerClient.streamResponse(
          model,
          { ...rewriteRequestBase, stream: true },
          { signal: controller.signal },
        )
        let accumulated = ''
        for await (const chunk of streamIterator) {
          if (controller.signal.aborted) {
            break
          }

          const delta = chunk?.choices?.[0]?.delta
          const piece = delta?.content ?? ''
          if (!piece) continue
          accumulated += piece
        }
        rewritten = stripFences(accumulated).trim()
      } else {
        const response = await providerClient.generateResponse(
          model,
          { ...rewriteRequestBase, stream: false },
          { signal: controller.signal },
        )
        rewritten = stripFences(
          response.choices?.[0]?.message?.content ?? '',
        ).trim()
      }
      if (!rewritten) {
        notice.setMessage('未生成改写内容。')
        this.deps.registerTimeout(() => notice.hide(), 1200)
        return
      }

      const activeFile = this.deps.app.workspace.getActiveFile()
      if (!activeFile) {
        notice.setMessage('未找到当前文件。')
        this.deps.registerTimeout(() => notice.hide(), 1200)
        return
      }

      const head = editor.getRange({ line: 0, ch: 0 }, from)
      const originalContent = await readTFileContent(
        activeFile,
        this.deps.app.vault,
      )
      const tail = originalContent.slice(head.length + selected.length)
      const newContent = head + rewritten + tail

      await this.deps.openApplyReview({
        file: activeFile,
        originalContent,
        newContent,
      } satisfies ApplyViewState)

      notice.setMessage('改写结果已生成。')
      this.deps.registerTimeout(() => notice.hide(), 1200)
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        notice.setMessage('已取消生成。')
        this.deps.registerTimeout(() => notice.hide(), 1000)
      } else {
        console.error(error)
        notice.setMessage('改写失败。')
        this.deps.registerTimeout(() => notice.hide(), 1200)
      }
    } finally {
      this.deps.removeAbortController(controller)
    }
  }

  async handleContinueWriting(
    editor: Editor,
    customPrompt?: string,
    geminiTools?: { useWebSearch?: boolean; useUrlContext?: boolean },
    mentionables?: (MentionableFile | MentionableFolder)[],
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
            const referenceLabel = this.deps.t(
              'sidebar.composer.referenceRulesTitle',
              'Reference rules',
            )
            const blocks = referenceFiles.map((file, index) => {
              const content = referenceContents[index] ?? ''
              return `File: ${file.path}\n${content}`
            })
            const combinedReference = blocks.join('\n\n')
            if (combinedReference.trim().length > 0) {
              referenceRulesSection = `${referenceLabel}:\n\n${combinedReference}\n\n`
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
            const mentionLabel = this.deps.t(
              'smartSpace.mentionContextLabel',
              'Mentioned files',
            )
            const combined = files
              .map((file, index) => {
                const content = contents[index] ?? ''
                return `File: ${file.path}\n${content}`
              })
              .join('\n\n')
            if (combined.trim().length > 0) {
              mentionableContextSection = `${mentionLabel}:\n\n${combined}\n\n`
            }
          }
        } catch (error) {
          console.warn(
            'Failed to include mentioned files for Smart Space continuation',
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

      const continuationModelId =
        settings.continuationOptions?.continuationModelId ??
        settings.chatModelId

      const sidebarOverrides = this.deps.getActiveConversationOverrides()
      const {
        temperature,
        topP,
        stream: streamPreference,
        useVaultSearch,
      } = this.deps.resolveContinuationParams(sidebarOverrides)

      const { providerClient, model } = getChatModelClient({
        settings,
        modelId: continuationModelId,
      })

      const userInstruction = (customPrompt ?? '').trim()
      const instructionSection = userInstruction
        ? `Instruction:\n${userInstruction}\n\n`
        : ''

      const systemPrompt = (settings.systemPrompt ?? '').trim()

      const activeFileForTitle = this.deps.app.workspace.getActiveFile()
      const fileTitle = activeFileForTitle?.basename?.trim() ?? ''
      const titleLine = fileTitle ? `File title: ${fileTitle}\n\n` : ''
      const hasContext = (baseContext ?? '').trim().length > 0

      let ragContextSection = ''
      const knowledgeBaseRaw =
        settings.continuationOptions?.knowledgeBaseFolders ?? []
      const knowledgeBaseFolders: string[] = []
      const knowledgeBaseFiles: string[] = []
      for (const raw of knowledgeBaseRaw) {
        const trimmed = raw.trim()
        if (!trimmed) continue
        const abstract = this.deps.app.vault.getAbstractFileByPath(trimmed)
        if (abstract instanceof TFolder) {
          knowledgeBaseFolders.push(abstract.path)
        } else if (abstract instanceof TFile) {
          knowledgeBaseFiles.push(abstract.path)
        }
      }
      const ragGloballyEnabled = Boolean(settings.ragOptions?.enabled)
      if (useVaultSearch && ragGloballyEnabled) {
        try {
          const querySource = (
            baseContext ||
            userInstruction ||
            fileTitle
          ).trim()
          if (querySource.length > 0) {
            const ragEngine = await this.deps.getRagEngine()
            const ragResults = await ragEngine.processQuery({
              query: querySource.slice(-4000),
              scope:
                knowledgeBaseFolders.length > 0 || knowledgeBaseFiles.length > 0
                  ? {
                      folders: knowledgeBaseFolders,
                      files: knowledgeBaseFiles,
                    }
                  : undefined,
            })
            const snippetLimit = Math.max(
              1,
              Math.min(settings.ragOptions?.limit ?? 10, 10),
            )
            const snippets = ragResults.slice(0, snippetLimit)
            if (snippets.length > 0) {
              const formatted = snippets
                .map((snippet, index) => {
                  const content = (snippet.content ?? '').trim()
                  const truncated =
                    content.length > 600
                      ? `${content.slice(0, 600)}...`
                      : content
                  return `Snippet ${index + 1} (from ${snippet.path}):\n${truncated}`
                })
                .join('\n\n')
              if (formatted.trim().length > 0) {
                ragContextSection = `Vault snippets:\n\n${formatted}\n\n`
              }
            }
          }
        } catch (error) {
          console.warn('Continuation RAG lookup failed:', error)
        }
      }

      if (controller.signal.aborted) {
        return
      }

      const limitedContextHasContent = limitedContext.trim().length > 0
      const contextSection =
        hasContext && limitedContextHasContent
          ? `Context (up to recent portion):\n\n${limitedContext}\n\n`
          : ''
      const baseModelContextSection = `${
        referenceRulesSection
      }${mentionableContextSection}${
        hasContext && limitedContextHasContent ? `${limitedContext}\n\n` : ''
      }${ragContextSection}`
      const combinedContextSection = `${referenceRulesSection}${mentionableContextSection}${contextSection}${ragContextSection}`

      const isBaseModel = Boolean(model.isBaseModel)
      const baseModelSpecialPrompt = (
        settings.chatOptions.baseModelSpecialPrompt ?? ''
      ).trim()
      const basePromptSection =
        isBaseModel && baseModelSpecialPrompt.length > 0
          ? `${baseModelSpecialPrompt}\n\n`
          : ''
      const baseModelCoreContent = `${basePromptSection}${titleLine}${instructionSection}${baseModelContextSection}`

      const userMessageContent = isBaseModel
        ? `${baseModelCoreContent}`
        : `${basePromptSection}${titleLine}${instructionSection}${combinedContextSection}`

      const requestMessages: RequestMessage[] = [
        ...(!isBaseModel && systemPrompt.length > 0
          ? [
              {
                role: 'system' as const,
                content: systemPrompt,
              },
            ]
          : []),
        {
          role: 'user' as const,
          content: userMessageContent,
        },
      ]

      this.deps.setContinuationInProgress(true)

      view = this.deps.getEditorView(editor)
      if (!view) {
        notice.setMessage('Unable to access editor view.')
        this.deps.registerTimeout(() => notice.hide(), 1200)
        return
      }

      this.deps.ensureInlineSuggestionExtension(view)

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

      let hasClosedSmartSpaceWidget = false
      const closeSmartSpaceWidgetOnce = () => {
        if (!hasClosedSmartSpaceWidget) {
          this.deps.closeSmartSpace()
          hasClosedSmartSpaceWidget = true
        }
      }

      closeSmartSpaceWidgetOnce()

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
        useVaultSearch,
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

      const runNonStreaming = async () => {
        const response = await providerClient.generateResponse(
          model,
          { ...baseRequest, stream: false },
          { signal: controller.signal, geminiTools },
        )

        const fullText = response.choices?.[0]?.message?.content ?? ''
        if (fullText) {
          suggestionText = fullText
          closeSmartSpaceWidgetOnce()
          updateContinuationSuggestion(suggestionText)
        }
      }

      if (streamPreference) {
        const streamController = new AbortController()
        const handleAbort = () => streamController.abort()
        controller.signal.addEventListener('abort', handleAbort, { once: true })
        let firstTokenTimeoutId: ReturnType<typeof setTimeout> | null = null
        let didTimeout = false
        let hasReceivedFirstChunk = false
        const clearFirstTokenTimeout = () => {
          if (firstTokenTimeoutId) {
            clearTimeout(firstTokenTimeoutId)
            firstTokenTimeoutId = null
          }
        }
        try {
          firstTokenTimeoutId = setTimeout(() => {
            didTimeout = true
            streamController.abort()
          }, FIRST_TOKEN_TIMEOUT_MS)

          const streamIterator = await providerClient.streamResponse(
            model,
            { ...baseRequest, stream: true },
            { signal: streamController.signal, geminiTools },
          )

          for await (const chunk of streamIterator) {
            if (!hasReceivedFirstChunk) {
              hasReceivedFirstChunk = true
              clearFirstTokenTimeout()
            }
            if (controller.signal.aborted) {
              break
            }

            const delta = chunk?.choices?.[0]?.delta
            const piece = delta?.content ?? ''
            const reasoningDelta = delta?.reasoning ?? ''
            if (reasoningDelta) {
              reasoningPreviewBuffer += reasoningDelta
              if (reasoningPreviewBuffer.length > MAX_REASONING_BUFFER) {
                reasoningPreviewBuffer =
                  reasoningPreviewBuffer.slice(-MAX_REASONING_BUFFER)
              }
              updateThinkingReasoningPreview()
            }
            if (!piece) continue

            suggestionText += piece
            closeSmartSpaceWidgetOnce()
            updateContinuationSuggestion(suggestionText)
          }
        } catch (error) {
          clearFirstTokenTimeout()
          if (didTimeout && !controller.signal.aborted) {
            await runNonStreaming()
          } else {
            throw error
          }
        } finally {
          clearFirstTokenTimeout()
          controller.signal.removeEventListener('abort', handleAbort)
        }
      } else {
        await runNonStreaming()
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
