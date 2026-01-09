import { EditorView } from '@codemirror/view'
import {
  $getRoot,
  $nodesOfType,
  LexicalEditor,
  SerializedEditorState,
} from 'lexical'
import {
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  RotateCcw,
  Send,
  Square,
  X,
} from 'lucide-react'
import { Component, Editor, MarkdownRenderer, Notice } from 'obsidian'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

import { ApplyViewState } from '../../../ApplyView'
import { APPLY_VIEW_TYPE } from '../../../constants'
import { useApp } from '../../../contexts/app-context'
import { useLanguage } from '../../../contexts/language-context'
import { useMcp } from '../../../contexts/mcp-context'
import { useRAG } from '../../../contexts/rag-context'
import { useSettings } from '../../../contexts/settings-context'
import { getChatModelClient } from '../../../core/llm/manager'
import { useChatHistory } from '../../../hooks/useChatHistory'
import SmartComposerPlugin from '../../../main'
import { Assistant } from '../../../types/assistant.types'
import { ChatMessage, ChatUserMessage } from '../../../types/chat'
import { Mentionable, SerializedMentionable } from '../../../types/mentionable'
import { renderAssistantIcon } from '../../../utils/assistant-icon'
import { generateEditContent } from '../../../utils/chat/editMode'
import {
  deserializeMentionable,
  getMentionableKey,
  serializeMentionable,
} from '../../../utils/chat/mentionable'
import { parseTagContents } from '../../../utils/chat/parse-tag-content'
import { PromptGenerator } from '../../../utils/chat/promptGenerator'
import { ResponseGenerator } from '../../../utils/chat/responseGenerator'
import {
  applySearchReplaceBlocks,
  parseSearchReplaceBlocks,
} from '../../../utils/chat/searchReplace'
import { readTFileContent } from '../../../utils/obsidian'
import AssistantMessageReasoning from '../../chat-view/AssistantMessageReasoning'
import LexicalContentEditable from '../../chat-view/chat-input/LexicalContentEditable'
import { ModelSelect } from '../../chat-view/chat-input/ModelSelect'
import { MentionNode } from '../../chat-view/chat-input/plugins/mention/MentionNode'
import { NodeMutations } from '../../chat-view/chat-input/plugins/on-mutation/OnMutationPlugin'
import { editorStateToPlainText } from '../../chat-view/chat-input/utils/editor-state-to-plain-text'

import { AssistantSelectMenu } from './AssistantSelectMenu'
import { ModeSelect, QuickAskMode } from './ModeSelect'

const FIRST_TOKEN_TIMEOUT_MS = 12000

type QuickAskPanelProps = {
  plugin: SmartComposerPlugin
  editor: Editor
  view: EditorView
  contextText: string
  fileTitle: string
  onClose: () => void
  containerRef?: React.RefObject<HTMLDivElement>
  onOverlayStateChange?: (isOverlayActive: boolean) => void
  onDragOffset?: (offsetX: number, offsetY: number) => void
  onResize?: (width: number, height: number) => void
}

// Simple markdown renderer component for Quick Ask
function SimpleMarkdownContent({
  content,
  component,
}: {
  content: string
  component: Component
  scale?: 'xs' | 'sm' | 'base'
}) {
  const app = useApp()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (containerRef.current && content) {
      containerRef.current.replaceChildren()
      void MarkdownRenderer.render(
        app,
        content,
        containerRef.current,
        '',
        component,
      )
    }
  }, [app, component, content])

  return (
    <div
      ref={containerRef}
      className="markdown-rendered smtcmp-markdown-rendered"
    />
  )
}

export function QuickAskPanel({
  plugin,
  editor,
  view: _view,
  contextText,
  fileTitle,
  onClose,
  containerRef,
  onOverlayStateChange,
  onDragOffset,
  onResize,
}: QuickAskPanelProps) {
  const app = useApp()
  const { settings } = useSettings()
  const { setSettings } = useSettings()
  const { t } = useLanguage()
  const { getRAGEngine } = useRAG()
  const { getMcpManager } = useMcp()
  const { createOrUpdateConversation, generateConversationTitle } =
    useChatHistory()

  const assistants = settings.assistants || []
  const currentAssistantId = settings.currentAssistantId

  // State
  const [selectedAssistant, setSelectedAssistant] = useState<Assistant | null>(
    () => {
      if (currentAssistantId) {
        return assistants.find((a) => a.id === currentAssistantId) || null
      }
      return null
    },
  )
  const [conversationId] = useState(() => uuidv4())
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [inputText, setInputText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isAssistantMenuOpen, setIsAssistantMenuOpen] = useState(false)
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false)
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false)
  const [isMentionMenuOpen, setIsMentionMenuOpen] = useState(false)
  const [mentionMenuPlacement, setMentionMenuPlacement] = useState<
    'top' | 'bottom'
  >('top')
  const [mentionables, setMentionables] = useState<Mentionable[]>([])
  const [mode, setMode] = useState<QuickAskMode>(
    () => settings.continuationOptions?.quickAskMode ?? 'ask',
  )
  const assistantDropdownRef = useRef<HTMLDivElement | null>(null)
  const assistantTriggerRef = useRef<HTMLButtonElement | null>(null)
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null)
  const modeTriggerRef = useRef<HTMLButtonElement | null>(null)

  const inputRowRef = useRef<HTMLDivElement | null>(null)
  const contentEditableRef = useRef<HTMLDivElement>(null)
  const lexicalEditorRef = useRef<LexicalEditor | null>(null)
  const chatAreaRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const userDisabledAutoScrollRef = useRef(false)
  const lastScrollTopRef = useRef(0)

  // Drag & Resize state
  const dragHandleRef = useRef<HTMLDivElement>(null)
  const resizeHandlesRef = useRef<{
    right?: HTMLDivElement | null
    bottom?: HTMLDivElement | null
    bottomRight?: HTMLDivElement | null
  }>({})
  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const dragStartRef = useRef<{
    x: number
    y: number
    panelX: number
    panelY: number
  } | null>(null)
  const resizeStartRef = useRef<{
    direction: 'right' | 'bottom' | 'bottom-right'
    x: number
    y: number
    width: number
    height: number
  } | null>(null)
  const [panelSize, setPanelSize] = useState<{
    width: number
    height: number
  } | null>(null)
  const renderAssistantBlocks = useCallback(
    (rawContent: string | undefined | null) => {
      const parsed = parseTagContents(rawContent ?? '')
      const rendered: React.JSX.Element[] = []

      parsed.forEach((block, index) => {
        if (block.type === 'think') {
          if (!block.content.trim()) return
          rendered.push(
            <AssistantMessageReasoning
              key={index}
              reasoning={block.content}
              content={rawContent ?? ''}
              MarkdownComponent={({ content }) => (
                <SimpleMarkdownContent content={content} component={plugin} />
              )}
            />,
          )
          return
        }

        if (block.type === 'smtcmp_block') {
          const normalizedContent =
            block.language && block.language !== 'markdown'
              ? `\`\`\`${block.language}\n${block.content}\n\`\`\``
              : block.content
          if (!normalizedContent.trim()) return
          rendered.push(
            <div key={index} className="smtcmp-quick-ask-assistant-block">
              <SimpleMarkdownContent
                content={normalizedContent}
                component={plugin}
              />
            </div>,
          )
          return
        }

        if (!block.content.trim()) return
        rendered.push(
          <div key={index} className="smtcmp-quick-ask-assistant-block">
            <SimpleMarkdownContent content={block.content} component={plugin} />
          </div>,
        )
      })

      return rendered
    },
    [plugin],
  )

  const updateMentionMenuPlacement = useCallback(() => {
    const container = inputRowRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const viewportHeight = window.innerHeight
    const margin = 16
    const preferredHeight = 260
    const spaceAbove = rect.top - margin
    const spaceBelow = viewportHeight - rect.bottom - margin

    if (spaceAbove < preferredHeight && spaceBelow > spaceAbove) {
      setMentionMenuPlacement('bottom')
    } else {
      setMentionMenuPlacement('top')
    }
  }, [])

  // Handle mention node mutations to track mentionables
  const handleMentionNodeMutation = useCallback(
    (mutations: NodeMutations<MentionNode>) => {
      const destroyedMentionableKeys: string[] = []
      const addedMentionables: SerializedMentionable[] = []

      mutations.forEach((mutation) => {
        const mentionable = mutation.node.getMentionable()
        const mentionableKey = getMentionableKey(mentionable)

        if (mutation.mutation === 'destroyed') {
          const nodeWithSameMentionable = lexicalEditorRef.current?.read(() =>
            $nodesOfType(MentionNode).find(
              (node) =>
                getMentionableKey(node.getMentionable()) === mentionableKey,
            ),
          )

          if (!nodeWithSameMentionable) {
            // remove mentionable only if it's not present in the editor state
            destroyedMentionableKeys.push(mentionableKey)
          }
        } else if (mutation.mutation === 'created') {
          if (
            mentionables.some(
              (m) =>
                getMentionableKey(serializeMentionable(m)) === mentionableKey,
            ) ||
            addedMentionables.some(
              (m) => getMentionableKey(m) === mentionableKey,
            )
          ) {
            // do nothing if mentionable is already added
            return
          }

          addedMentionables.push(mentionable)
        }
      })

      setMentionables((prev) =>
        prev
          .filter(
            (m) =>
              !destroyedMentionableKeys.includes(
                getMentionableKey(serializeMentionable(m)),
              ),
          )
          .concat(
            addedMentionables
              .map((m) => deserializeMentionable(m, app))
              .filter((v): v is Mentionable => !!v),
          ),
      )
    },
    [app, mentionables],
  )

  // Build promptGenerator with context
  const promptGenerator = useMemo(() => {
    const globalSystemPrompt = settings.systemPrompt || ''
    const assistantPrompt = selectedAssistant?.systemPrompt || ''
    const trimmedTitle = fileTitle.trim()
    const hasTitle = trimmedTitle.length > 0
    const hasContext = contextText.trim().length > 0
    const titleSection = hasTitle ? `File title: ${trimmedTitle}\n` : ''
    const contextBlock = hasContext
      ? `Here is the text before the cursor (context):\n"""\n${contextText}\n"""\n`
      : ''
    const contextSection =
      hasTitle || hasContext
        ? `\n\nThe user is asking a question in the context of their current document.\n${titleSection}${contextBlock}\nAnswer the user's question based on this context when relevant.`
        : ''

    const combinedSystemPrompt =
      `${globalSystemPrompt}\n\n${assistantPrompt}${contextSection}`.trim()

    return new PromptGenerator(getRAGEngine, app, {
      ...settings,
      systemPrompt: combinedSystemPrompt,
    })
  }, [app, contextText, getRAGEngine, selectedAssistant, settings])

  // Track user scroll position to determine if we should auto-scroll
  useEffect(() => {
    const chatArea = chatAreaRef.current
    if (!chatArea) return

    const disableAutoScroll = () => {
      shouldAutoScrollRef.current = false
    }

    const handleScroll = () => {
      // Check if user is near the bottom (within 100px)
      const distanceToBottom =
        chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight
      const isNearBottom = distanceToBottom < 100

      const currentScrollTop = chatArea.scrollTop
      const scrolledUp = currentScrollTop < lastScrollTopRef.current
      lastScrollTopRef.current = currentScrollTop

      if (scrolledUp) {
        // 用户向上滚动，立即关闭自动滚动
        userDisabledAutoScrollRef.current = true
        shouldAutoScrollRef.current = false
        return
      }

      if (userDisabledAutoScrollRef.current) {
        // 只有用户手动滚回底部附近才恢复自动滚动
        if (isNearBottom) {
          userDisabledAutoScrollRef.current = false
          shouldAutoScrollRef.current = true
        }
        return
      }

      shouldAutoScrollRef.current = isNearBottom
    }

    // Initialize state based on current position
    handleScroll()

    chatArea.addEventListener('scroll', handleScroll)
    chatArea.addEventListener('wheel', disableAutoScroll, { passive: true })
    chatArea.addEventListener('touchstart', disableAutoScroll, {
      passive: true,
    })
    chatArea.addEventListener('pointerdown', disableAutoScroll)
    return () => {
      chatArea.removeEventListener('scroll', handleScroll)
      chatArea.removeEventListener('wheel', disableAutoScroll)
      chatArea.removeEventListener('touchstart', disableAutoScroll)
      chatArea.removeEventListener('pointerdown', disableAutoScroll)
    }
  }, [chatMessages.length])

  // Auto-scroll to bottom when messages change, but only if user hasn't scrolled up
  useEffect(() => {
    if (chatAreaRef.current && shouldAutoScrollRef.current) {
      chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight
    }
  }, [chatMessages])

  // Focus input on mount
  useEffect(() => {
    setTimeout(() => {
      contentEditableRef.current?.focus()
    }, 100)
  }, [])

  useEffect(() => {
    if (!isMentionMenuOpen) return
    updateMentionMenuPlacement()

    const handleResize = () => updateMentionMenuPlacement()
    window.addEventListener('resize', handleResize)
    window.addEventListener('scroll', handleResize, true)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('scroll', handleResize, true)
    }
  }, [isMentionMenuOpen, updateMentionMenuPlacement])

  // Notify overlay state changes
  useEffect(() => {
    onOverlayStateChange?.(
      isAssistantMenuOpen ||
        isModelMenuOpen ||
        isModeMenuOpen ||
        isMentionMenuOpen,
    )
  }, [
    isAssistantMenuOpen,
    isModelMenuOpen,
    isModeMenuOpen,
    isMentionMenuOpen,
    onOverlayStateChange,
  ])

  // Arrow keys focus assistant trigger; Enter on the trigger will open the menu
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isAssistantMenuOpen || isModelMenuOpen || isModeMenuOpen) return
      const active = document.activeElement
      if (
        (active && assistantTriggerRef.current?.contains(active)) ||
        (active && modelTriggerRef.current?.contains(active)) ||
        (active && modeTriggerRef.current?.contains(active)) ||
        (active && contentEditableRef.current?.contains(active))
      ) {
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      event.stopPropagation()
      assistantTriggerRef.current?.focus()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isAssistantMenuOpen, isModelMenuOpen, isModeMenuOpen])

  // When focus在助手按钮但菜单未展开时，ArrowUp 将焦点送回输入框（兜底）
  useEffect(() => {
    const handleArrowUpBack = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowUp') return
      if (isAssistantMenuOpen) return
      const active = document.activeElement
      if (active !== assistantTriggerRef.current) return
      event.preventDefault()
      event.stopPropagation()
      contentEditableRef.current?.focus()
    }
    window.addEventListener('keydown', handleArrowUpBack, true)
    return () => window.removeEventListener('keydown', handleArrowUpBack, true)
  }, [isAssistantMenuOpen])

  // When assistant menu已打开时按 Esc：只关闭菜单并回焦输入
  useEffect(() => {
    const handleMenuEscape = (event: KeyboardEvent) => {
      if (!isAssistantMenuOpen) return
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setIsAssistantMenuOpen(false)
      requestAnimationFrame(() => {
        contentEditableRef.current?.focus()
      })
    }
    window.addEventListener('keydown', handleMenuEscape, true)
    return () => window.removeEventListener('keydown', handleMenuEscape, true)
  }, [isAssistantMenuOpen])

  // Get model client
  const { providerClient, model } = useMemo(() => {
    const continuationModelId =
      settings.continuationOptions?.continuationModelId
    const preferredModelId =
      continuationModelId &&
      settings.chatModels.some((m) => m.id === continuationModelId)
        ? continuationModelId
        : settings.chatModelId

    return getChatModelClient({ settings, modelId: preferredModelId })
  }, [settings])

  // Abort current stream
  const abortStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setIsStreaming(false)
  }, [])

  // Submit message
  const submitMessage = useCallback(
    async (editorState: SerializedEditorState) => {
      if (isStreaming) return

      // Extract text from editor state
      const textContent = editorStateToPlainText(editorState)
      if (!textContent.trim()) return

      setIsStreaming(true)
      setInputText('')

      // Clear the lexical editor
      lexicalEditorRef.current?.update(() => {
        const root = lexicalEditorRef.current?.getEditorState().read(() => {
          return $getRoot()
        })
        if (root) {
          root.clear()
        }
      })

      // Create user message with all required fields
      // Note: promptContent is set to null so that compileUserMessagePrompt will be called
      // to properly process mentionables and include file contents
      const userMessage: ChatUserMessage = {
        role: 'user',
        content: editorState,
        promptContent: null,
        id: uuidv4(),
        mentionables: mentionables,
      }

      // Clear mentionables after creating the message
      setMentionables([])

      const newMessages: ChatMessage[] = [...chatMessages, userMessage]
      setChatMessages(newMessages)

      // Create abort controller
      const abortController = new AbortController()
      abortControllerRef.current = abortController

      try {
        const mcpManager = await getMcpManager()

        const responseGenerator = new ResponseGenerator({
          providerClient,
          model,
          messages: newMessages,
          conversationId,
          enableTools: settings.chatOptions.enableTools,
          maxAutoIterations: settings.chatOptions.maxAutoIterations,
          promptGenerator,
          mcpManager,
          abortSignal: abortController.signal,
          firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS,
          requestParams: {
            stream: true,
          },
        })

        const unsubscribe = responseGenerator.subscribe((responseMessages) => {
          setChatMessages((prev) => {
            const lastMessageIndex = prev.findIndex(
              (m) => m.id === userMessage.id,
            )
            if (lastMessageIndex === -1) {
              abortController.abort()
              return prev
            }
            return [...prev.slice(0, lastMessageIndex + 1), ...responseMessages]
          })
        })

        await responseGenerator.run()
        unsubscribe()

        // Save conversation
        const finalMessages = [...newMessages]
        setChatMessages((current) => {
          finalMessages.push(...current.slice(newMessages.length))
          return current
        })

        if (createOrUpdateConversation) {
          void Promise.resolve(
            createOrUpdateConversation(conversationId, finalMessages),
          ).catch((error) => {
            console.error('Failed to save quick ask conversation', error)
          })
        }
        if (generateConversationTitle) {
          void Promise.resolve(
            generateConversationTitle(conversationId, finalMessages),
          ).catch((error) => {
            console.error(
              'Failed to generate quick ask conversation title',
              error,
            )
          })
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          // Aborted by user
          return
        }
        console.error('Quick ask failed:', error)
        new Notice(t('quickAsk.error', 'Failed to generate response'))
      } finally {
        setIsStreaming(false)
        abortControllerRef.current = null
      }
    },
    [
      chatMessages,
      conversationId,
      createOrUpdateConversation,
      generateConversationTitle,
      getMcpManager,
      isStreaming,
      mentionables,
      model,
      promptGenerator,
      providerClient,
      settings,
      t,
    ],
  )

  // Submit edit mode - generate SEARCH/REPLACE and open ApplyView
  const submitEditMode = useCallback(
    async (instruction: string) => {
      if (isStreaming) return
      if (!instruction.trim()) return

      const activeFile = app.workspace.getActiveFile()
      if (!activeFile) {
        new Notice(t('quickAsk.editNoFile', 'Please open a file first'))
        return
      }

      setIsStreaming(true)

      // Clear the lexical editor
      lexicalEditorRef.current?.update(() => {
        const root = lexicalEditorRef.current?.getEditorState().read(() => {
          return $getRoot()
        })
        if (root) {
          root.clear()
        }
      })
      setInputText('')

      try {
        const currentContent = await readTFileContent(activeFile, app.vault)

        // Generate SEARCH/REPLACE blocks
        const response = await generateEditContent({
          instruction,
          currentFile: activeFile,
          currentFileContent: currentContent,
          providerClient,
          model,
        })

        // Parse SEARCH/REPLACE blocks
        const blocks = parseSearchReplaceBlocks(response)
        if (blocks.length === 0) {
          new Notice(
            t('quickAsk.editNoChanges', 'No valid changes returned by model'),
          )
          return
        }

        // Apply blocks to original content
        const { newContent, errors, appliedCount } = applySearchReplaceBlocks(
          currentContent,
          blocks,
        )

        if (appliedCount === 0) {
          new Notice(
            t(
              'quickAsk.editNoChanges',
              'Could not apply any changes. The model output may not match the document.',
            ),
          )
          return
        }

        if (errors.length > 0) {
          console.warn('Some replacements failed:', errors)
        }

        // Open ApplyView
        await app.workspace.getLeaf(true).setViewState({
          type: APPLY_VIEW_TYPE,
          active: true,
          state: {
            file: activeFile,
            originalContent: currentContent,
            newContent,
          } satisfies ApplyViewState,
        })

        // Close Quick Ask
        onClose()
      } catch (error) {
        console.error('Edit mode failed:', error)
        new Notice(t('quickAsk.error', 'Failed to generate edits'))
      } finally {
        setIsStreaming(false)
      }
    },
    [app, isStreaming, model, onClose, providerClient, t],
  )

  // Submit edit-direct mode - generate and apply edits directly without confirmation
  const submitEditDirect = useCallback(
    async (instruction: string) => {
      if (isStreaming) return
      if (!instruction.trim()) return

      const activeFile = app.workspace.getActiveFile()
      if (!activeFile) {
        new Notice(t('quickAsk.editNoFile', 'Please open a file first'))
        return
      }

      setIsStreaming(true)

      // Clear the lexical editor
      lexicalEditorRef.current?.update(() => {
        const root = lexicalEditorRef.current?.getEditorState().read(() => {
          return $getRoot()
        })
        if (root) {
          root.clear()
        }
      })
      setInputText('')

      try {
        const currentContent = await readTFileContent(activeFile, app.vault)

        // Generate edit blocks
        const response = await generateEditContent({
          instruction,
          currentFile: activeFile,
          currentFileContent: currentContent,
          providerClient,
          model,
        })

        // Parse edit blocks
        const blocks = parseSearchReplaceBlocks(response)
        if (blocks.length === 0) {
          new Notice(
            t('quickAsk.editNoChanges', 'No valid changes returned by model'),
          )
          return
        }

        // Apply blocks to original content
        const { newContent, errors, appliedCount } = applySearchReplaceBlocks(
          currentContent,
          blocks,
        )

        if (appliedCount === 0) {
          new Notice(
            t(
              'quickAsk.editNoChanges',
              'Could not apply any changes. The model output may not match the document.',
            ),
          )
          return
        }

        if (errors.length > 0) {
          console.warn('Some edits failed:', errors)
          const partialMessage = t(
            'quickAsk.editPartialSuccess',
            `Applied ${appliedCount} of ${blocks.length} edits. Check console for details.`,
          )
            .replace('${appliedCount}', String(appliedCount))
            .replace('${blocks.length}', String(blocks.length))
          new Notice(partialMessage)
        }

        // Apply changes directly to file
        await app.vault.modify(activeFile, newContent)

        const successMessage = t(
          'quickAsk.editApplied',
          `Successfully applied ${appliedCount} edit(s) to ${activeFile.name}`,
        )
          .replace('${appliedCount}', String(appliedCount))
          .replace('${activeFile.name}', activeFile.name)
        new Notice(successMessage)

        // Close Quick Ask
        onClose()
      } catch (error) {
        console.error('Edit-direct mode failed:', error)
        new Notice(t('quickAsk.error', 'Failed to apply edits'))
      } finally {
        setIsStreaming(false)
      }
    },
    [app, isStreaming, model, onClose, providerClient, t],
  )

  // Handle mode change
  const handleModeChange = useCallback(
    (newMode: QuickAskMode) => {
      setMode(newMode)
      void setSettings({
        ...settings,
        continuationOptions: {
          ...settings.continuationOptions,
          quickAskMode: newMode,
        },
      })
    },
    [setSettings, settings],
  )

  // Handle Enter key
  const handleEnter = useCallback(
    (event: KeyboardEvent) => {
      if (event.shiftKey) return // Allow Shift+Enter for newline

      const lexicalEditor = lexicalEditorRef.current
      if (lexicalEditor) {
        const editorState = lexicalEditor.getEditorState().toJSON()
        const textContent = editorStateToPlainText(editorState)

        if (mode === 'edit') {
          void submitEditMode(textContent)
        } else if (mode === 'edit-direct') {
          void submitEditDirect(textContent)
        } else {
          void submitMessage(editorState)
        }
      }
    },
    [mode, submitEditMode, submitEditDirect, submitMessage],
  )

  // Copy last assistant message
  const copyLastResponse = useCallback(() => {
    const lastAssistantMessage = [...chatMessages]
      .reverse()
      .find((m) => m.role === 'assistant')
    if (lastAssistantMessage && lastAssistantMessage.role === 'assistant') {
      void navigator.clipboard
        .writeText(lastAssistantMessage.content || '')
        .catch((error) => {
          console.error('Failed to copy to clipboard', error)
        })
      new Notice(t('quickAsk.copied', 'Copied to clipboard'))
    }
  }, [chatMessages, t])

  // Insert last assistant message at cursor
  const insertLastResponse = useCallback(() => {
    const lastAssistantMessage = [...chatMessages]
      .reverse()
      .find((m) => m.role === 'assistant')
    if (lastAssistantMessage && lastAssistantMessage.role === 'assistant') {
      const content = lastAssistantMessage.content || ''
      const cursor = editor.getCursor()
      editor.replaceRange(content, cursor)
      new Notice(t('quickAsk.inserted', 'Inserted at cursor'))
      onClose()
    }
  }, [chatMessages, editor, onClose, t])

  // Clear conversation
  const clearConversation = useCallback(() => {
    setChatMessages([])
    new Notice(t('quickAsk.cleared', 'Conversation cleared'))
    // Re-enable auto-scroll after clearing
    shouldAutoScrollRef.current = true
    userDisabledAutoScrollRef.current = false
    // Focus input after clearing
    setTimeout(() => {
      contentEditableRef.current?.focus()
    }, 0)
  }, [t])

  // Open in sidebar
  const hasMessages = chatMessages.length > 0
  const lastAssistantMessageId = useMemo(
    () => [...chatMessages].reverse().find((m) => m.role === 'assistant')?.id,
    [chatMessages],
  )

  // Global key handling to match palette UX (Esc closes, even when dropdown is open)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (isAssistantMenuOpen) {
        event.preventDefault()
        setIsAssistantMenuOpen(false)
        return
      }
      if (isModelMenuOpen || isModeMenuOpen) {
        // 交给下拉自身处理关闭，避免误关闭面板
        return
      }
      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isAssistantMenuOpen, isModelMenuOpen, isModeMenuOpen, onClose])

  // Drag handling
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current || !containerRef?.current) return

      const deltaX = e.clientX - dragStartRef.current.x
      const deltaY = e.clientY - dragStartRef.current.y

      const newX = dragStartRef.current.panelX + deltaX
      const newY = dragStartRef.current.panelY + deltaY

      onDragOffset?.(newX, newY)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      dragStartRef.current = null
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.classList.add('smtcmp-quick-ask-global-interaction')
    document.body.setCssProps({
      '--smtcmp-quick-ask-global-cursor': 'grabbing',
      '--smtcmp-quick-ask-global-user-select': 'none',
    })

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('smtcmp-quick-ask-global-interaction')
      document.body.setCssProps({
        '--smtcmp-quick-ask-global-cursor': '',
        '--smtcmp-quick-ask-global-user-select': '',
      })
    }
  }, [isDragging, containerRef, onDragOffset])

  // Resize handling
  useEffect(() => {
    if (!isResizing) return

    const direction = resizeStartRef.current?.direction
    const cursor =
      direction === 'right'
        ? 'ew-resize'
        : direction === 'bottom'
          ? 'ns-resize'
          : 'nwse-resize'

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeStartRef.current || !containerRef?.current) return

      const deltaX = e.clientX - resizeStartRef.current.x
      const deltaY = e.clientY - resizeStartRef.current.y

      let newWidth = resizeStartRef.current.width
      let newHeight = resizeStartRef.current.height

      if (
        resizeStartRef.current.direction === 'right' ||
        resizeStartRef.current.direction === 'bottom-right'
      ) {
        newWidth = Math.max(300, resizeStartRef.current.width + deltaX)
      }
      if (
        resizeStartRef.current.direction === 'bottom' ||
        resizeStartRef.current.direction === 'bottom-right'
      ) {
        newHeight = Math.max(200, resizeStartRef.current.height + deltaY)
      }

      setPanelSize({ width: newWidth, height: newHeight })
      onResize?.(newWidth, newHeight)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      resizeStartRef.current = null
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.classList.add('smtcmp-quick-ask-global-interaction')
    document.body.setCssProps({
      '--smtcmp-quick-ask-global-cursor': cursor,
      '--smtcmp-quick-ask-global-user-select': 'none',
    })

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('smtcmp-quick-ask-global-interaction')
      document.body.setCssProps({
        '--smtcmp-quick-ask-global-cursor': '',
        '--smtcmp-quick-ask-global-user-select': '',
      })
    }
  }, [isResizing, containerRef, onResize])

  // Drag handle mouse down
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef?.current) return

      const rect = containerRef.current.getBoundingClientRect()
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        panelX: rect.left,
        panelY: rect.top,
      }
      setIsDragging(true)
      e.preventDefault()
    },
    [containerRef],
  )

  // Resize handle mouse down
  const handleResizeStart = useCallback(
    (direction: 'right' | 'bottom' | 'bottom-right') =>
      (e: React.MouseEvent) => {
        if (!containerRef?.current) return

        const rect = containerRef.current.getBoundingClientRect()
        resizeStartRef.current = {
          direction,
          x: e.clientX,
          y: e.clientY,
          width: rect.width,
          height: rect.height,
        }
        setIsResizing(true)
        e.preventDefault()
        e.stopPropagation()
      },
    [containerRef],
  )

  return (
    <div
      className={`smtcmp-quick-ask-panel ${hasMessages ? 'has-messages' : ''} ${isDragging ? 'is-dragging' : ''} ${isResizing ? 'is-resizing' : ''}`}
      ref={containerRef ?? undefined}
      style={
        panelSize
          ? {
              width: panelSize.width,
              maxWidth: panelSize.width, // Override CSS max-width constraint
              ...(panelSize.height
                ? {
                    height: panelSize.height,
                    maxHeight: panelSize.height, // Override CSS max-height constraint
                  }
                : {}),
            }
          : undefined
      }
    >
      {/* Drag handle */}
      <div
        ref={dragHandleRef}
        className="smtcmp-quick-ask-drag-handle"
        onMouseDown={handleDragStart}
      >
        <div className="smtcmp-quick-ask-drag-indicator" />
      </div>

      {/* Top: Input row with close button (Cursor style) */}
      <div className="smtcmp-quick-ask-input-row" ref={inputRowRef}>
        <div
          className={`smtcmp-quick-ask-input ${isStreaming ? 'is-disabled' : ''}`}
        >
          <LexicalContentEditable
            editorRef={lexicalEditorRef}
            contentEditableRef={contentEditableRef}
            onTextContentChange={setInputText}
            onEnter={handleEnter}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                assistantTriggerRef.current?.focus()
              }
            }}
            onMentionMenuToggle={(open) => {
              setIsMentionMenuOpen(open)
              if (open) updateMentionMenuPlacement()
            }}
            onMentionNodeMutation={handleMentionNodeMutation}
            mentionMenuContainerRef={inputRowRef}
            mentionMenuPlacement={mentionMenuPlacement}
            autoFocus
            contentClassName="smtcmp-obsidian-textarea smtcmp-content-editable smtcmp-quick-ask-content-editable"
          />
          {inputText.length === 0 && (
            <div className="smtcmp-quick-ask-input-placeholder">
              {t('quickAsk.inputPlaceholder', 'Ask a question...')}
            </div>
          )}
        </div>
        <button
          className="smtcmp-quick-ask-close-button"
          onClick={onClose}
          aria-label={t('quickAsk.close', 'Close')}
        >
          <X size={14} />
        </button>
      </div>

      {/* Chat area - only shown when there are messages */}
      {hasMessages && (
        <div
          className="smtcmp-quick-ask-chat-area"
          ref={chatAreaRef}
          style={panelSize?.height ? { maxHeight: 'none' } : undefined}
        >
          {chatMessages.map((message) => {
            if (message.role === 'user') {
              const textContent =
                message.content && typeof message.content === 'object'
                  ? editorStateToPlainText(message.content)
                  : ''
              return (
                <div key={message.id} className="smtcmp-quick-ask-user-message">
                  {textContent}
                </div>
              )
            }
            if (message.role === 'assistant') {
              const isLatestAssistant = message.id === lastAssistantMessageId
              return (
                <div
                  key={message.id}
                  className="smtcmp-quick-ask-assistant-message"
                >
                  {message.reasoning?.trim() && (
                    <AssistantMessageReasoning
                      reasoning={message.reasoning}
                      content={message.content}
                      MarkdownComponent={({ content }) => (
                        <SimpleMarkdownContent
                          content={content}
                          component={plugin}
                        />
                      )}
                    />
                  )}
                  {renderAssistantBlocks(message.content)}
                  {isLatestAssistant && (
                    <div className="smtcmp-quick-ask-assistant-actions">
                      <button
                        className="smtcmp-quick-ask-toolbar-button"
                        onClick={copyLastResponse}
                        title={t('quickAsk.copy', 'Copy')}
                      >
                        <Copy size={14} />
                      </button>
                      <button
                        className="smtcmp-quick-ask-toolbar-button"
                        onClick={insertLastResponse}
                        title={t('quickAsk.insert', 'Insert')}
                      >
                        <ExternalLink size={14} />
                      </button>
                    </div>
                  )}
                </div>
              )
            }
            return null
          })}
        </div>
      )}

      {/* Bottom toolbar (Cursor style): assistant selector left, actions right */}
      <div className="smtcmp-quick-ask-toolbar">
        {/* Left: Assistant selector */}
        <div className="smtcmp-quick-ask-toolbar-left">
          <button
            ref={assistantTriggerRef}
            className="smtcmp-quick-ask-assistant-trigger"
            onClick={() => setIsAssistantMenuOpen(!isAssistantMenuOpen)}
            onKeyDown={(event) => {
              if (!isAssistantMenuOpen) {
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  event.stopPropagation()
                  contentEditableRef.current?.focus()
                  return
                }
                if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  event.preventDefault()
                  event.stopPropagation()
                  modelTriggerRef.current?.focus()
                  return
                }
              }
            }}
          >
            {selectedAssistant && (
              <span className="smtcmp-quick-ask-assistant-icon">
                {renderAssistantIcon(selectedAssistant.icon, 14)}
              </span>
            )}
            <span className="smtcmp-quick-ask-assistant-name">
              {selectedAssistant?.name ||
                t('quickAsk.noAssistant', 'No Assistant')}
            </span>
            {isAssistantMenuOpen ? (
              <ChevronUp size={12} />
            ) : (
              <ChevronDown size={12} />
            )}
          </button>

          {/* Assistant dropdown */}
          {isAssistantMenuOpen && (
            <div
              className="smtcmp-quick-ask-assistant-dropdown"
              ref={assistantDropdownRef}
            >
              <AssistantSelectMenu
                assistants={assistants}
                currentAssistantId={selectedAssistant?.id}
                onSelect={(assistant) => {
                  setSelectedAssistant(assistant)
                  void setSettings({
                    ...settings,
                    currentAssistantId: assistant?.id,
                  })
                  setIsAssistantMenuOpen(false)
                  requestAnimationFrame(() => {
                    contentEditableRef.current?.focus()
                  })
                }}
                onClose={() => setIsAssistantMenuOpen(false)}
                compact
              />
            </div>
          )}

          <div className="smtcmp-quick-ask-model-select smtcmp-smart-space-model-select">
            <ModelSelect
              ref={modelTriggerRef}
              modelId={
                settings.continuationOptions?.continuationModelId &&
                settings.chatModels.some(
                  (m) =>
                    m.id === settings.continuationOptions?.continuationModelId,
                )
                  ? settings.continuationOptions?.continuationModelId
                  : settings.chatModelId
              }
              onMenuOpenChange={(open) => setIsModelMenuOpen(open)}
              onChange={(modelId) => {
                void setSettings({
                  ...settings,
                  continuationOptions: {
                    ...settings.continuationOptions,
                    continuationModelId: modelId,
                  },
                })
              }}
              container={containerRef?.current ?? undefined}
              side="bottom"
              align="start"
              sideOffset={12}
              alignOffset={-4}
              contentClassName="smtcmp-smart-space-popover smtcmp-quick-ask-model-popover"
              onKeyDown={(event, isMenuOpen) => {
                if (isMenuOpen) {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setIsModelMenuOpen(false)
                  }
                  return
                }

                if (event.key === 'ArrowLeft') {
                  event.preventDefault()
                  assistantTriggerRef.current?.focus()
                  return
                }
                if (event.key === 'ArrowRight') {
                  event.preventDefault()
                  modeTriggerRef.current?.focus()
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  contentEditableRef.current?.focus()
                }
              }}
              onModelSelected={() => {
                requestAnimationFrame(() => {
                  modelTriggerRef.current?.focus({ preventScroll: true })
                })
              }}
            />
          </div>

          <div className="smtcmp-quick-ask-mode-select">
            <ModeSelect
              ref={modeTriggerRef}
              mode={mode}
              onChange={handleModeChange}
              onMenuOpenChange={(open) => setIsModeMenuOpen(open)}
              container={containerRef?.current ?? undefined}
              side="bottom"
              align="start"
              sideOffset={12}
              alignOffset={-4}
              contentClassName="smtcmp-smart-space-popover smtcmp-quick-ask-mode-popover"
              onKeyDown={(event, isMenuOpen) => {
                if (isMenuOpen) {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setIsModeMenuOpen(false)
                  }
                  return
                }

                if (event.key === 'ArrowLeft') {
                  event.preventDefault()
                  modelTriggerRef.current?.focus()
                  return
                }
                if (event.key === 'ArrowRight') {
                  event.preventDefault()
                  assistantTriggerRef.current?.focus()
                  return
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  contentEditableRef.current?.focus()
                }
              }}
            />
          </div>
        </div>

        {/* Right: Action buttons */}
        <div className="smtcmp-quick-ask-toolbar-right">
          {/* Clear conversation button - only shown when there are messages */}
          {hasMessages && (
            <button
              className="smtcmp-quick-ask-toolbar-button"
              onClick={clearConversation}
              aria-label={t('quickAsk.clear', 'Clear conversation')}
              title={t('quickAsk.clear', 'Clear conversation')}
            >
              <RotateCcw size={14} />
            </button>
          )}

          {/* Send/Stop button */}
          {isStreaming ? (
            <button
              className="smtcmp-quick-ask-send-button stop"
              onClick={abortStream}
              aria-label={t('quickAsk.stop', 'Stop')}
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              className="smtcmp-quick-ask-send-button"
              onClick={() => {
                const lexicalEditor = lexicalEditorRef.current
                if (lexicalEditor) {
                  const editorState = lexicalEditor.getEditorState().toJSON()
                  const textContent = editorStateToPlainText(editorState)

                  if (mode === 'edit') {
                    void submitEditMode(textContent)
                  } else {
                    void submitMessage(editorState)
                  }
                }
              }}
              disabled={inputText.trim().length === 0}
              aria-label={t('quickAsk.send', 'Send')}
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Resize handles */}
      <div
        className="smtcmp-quick-ask-resize-handle smtcmp-quick-ask-resize-handle-right"
        onMouseDown={handleResizeStart('right')}
        ref={(el) => (resizeHandlesRef.current.right = el)}
      />
      {hasMessages && (
        <>
          <div
            className="smtcmp-quick-ask-resize-handle smtcmp-quick-ask-resize-handle-bottom"
            onMouseDown={handleResizeStart('bottom')}
            ref={(el) => (resizeHandlesRef.current.bottom = el)}
          />
          <div
            className="smtcmp-quick-ask-resize-handle smtcmp-quick-ask-resize-handle-bottom-right"
            onMouseDown={handleResizeStart('bottom-right')}
            ref={(el) => (resizeHandlesRef.current.bottomRight = el)}
          />
        </>
      )}
    </div>
  )
}
