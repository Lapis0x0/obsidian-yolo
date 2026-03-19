import { EditorView } from '@codemirror/view'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $nodesOfType,
  LexicalEditor,
  SerializedEditorState,
} from 'lexical'
import {
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Send,
  Square,
  X,
} from 'lucide-react'
import { Editor, Notice } from 'obsidian'
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { v4 as uuidv4 } from 'uuid'

import { useApp } from '../../../contexts/app-context'
import { useLanguage } from '../../../contexts/language-context'
import { useMcp } from '../../../contexts/mcp-context'
import { useRAG } from '../../../contexts/rag-context'
import { useSettings } from '../../../contexts/settings-context'
import { getEnabledAssistantToolNames } from '../../../core/agent/tool-preferences'
import { getChatModelClient } from '../../../core/llm/manager'
import { listLiteSkillEntries } from '../../../core/skills/liteSkills'
import { isSkillEnabledForAssistant } from '../../../core/skills/skillPolicy'
import { useBufferedRunnerMessages } from '../../../hooks/useBufferedRunnerMessages'
import { useChatHistory } from '../../../hooks/useChatHistory'
import SmartComposerPlugin from '../../../main'
import type { ApplyViewState } from '../../../types/apply-view.types'
import { Assistant } from '../../../types/assistant.types'
import type {
  QuickAskLaunchMode,
  QuickAskSelectionScope,
} from '../../../features/editor/quick-ask/quickAsk.types'
import {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../../types/chat'
import {
  Mentionable,
  MentionableBlock,
  SerializedMentionable,
} from '../../../types/mentionable'
import { renderAssistantIcon } from '../../../utils/assistant-icon'
import { materializeTextEditPlan } from '../../../core/edits/textEditEngine'
import { parseTextEditPlan } from '../../../core/edits/textEditPlan'
import { generateEditPlan } from '../../../utils/chat/editMode'
import {
  deserializeMentionable,
  getMentionableKey,
  getMentionableName,
  serializeMentionable,
} from '../../../utils/chat/mentionable'
import { groupAssistantAndToolMessages } from '../../../utils/chat/message-groups'
import { RequestContextBuilder } from '../../../utils/chat/requestContextBuilder'
import { mergeCustomParameters } from '../../../utils/custom-parameters'
import { readTFileContent } from '../../../utils/obsidian'
import AssistantToolMessageGroupItem from '../../chat-view/AssistantToolMessageGroupItem'
import ChatUserInput, {
  ChatUserInputRef,
} from '../../chat-view/chat-input/ChatUserInput'
import LexicalContentEditable from '../../chat-view/chat-input/LexicalContentEditable'
import { ModelSelect } from '../../chat-view/chat-input/ModelSelect'
import {
  $createMentionNode,
  MentionNode,
} from '../../chat-view/chat-input/plugins/mention/MentionNode'
import { NodeMutations } from '../../chat-view/chat-input/plugins/on-mutation/OnMutationPlugin'
import { editorStateToPlainText } from '../../chat-view/chat-input/utils/editor-state-to-plain-text'

import { AssistantSelectMenu } from './AssistantSelectMenu'
import { ModeSelect, QuickAskMode } from './ModeSelect'

type QuickAskExecutionMode = QuickAskMode | 'edit' | 'edit-direct'

const QUICK_ASK_CHAT_MAX_ITERATIONS = 1
const QUICK_ASK_AGENT_MAX_ITERATIONS = 100
const QUICK_ASK_CURSOR_MARKER = '<<CURSOR>>'

function normalizeQuickAskVisibleMode(
  mode?: QuickAskLaunchMode | null,
): QuickAskMode {
  return mode === 'agent' ? 'agent' : 'chat'
}

function normalizeQuickAskExecutionMode(
  mode?: QuickAskLaunchMode | null,
): QuickAskExecutionMode {
  if (mode === 'agent' || mode === 'edit' || mode === 'edit-direct') {
    return mode
  }

  return 'chat'
}

function getSelectionMentionable(
  mentionables: Mentionable[],
): MentionableBlock | null {
  return (
    mentionables.find(
      (mentionable): mentionable is MentionableBlock =>
        mentionable.type === 'block' && mentionable.source === 'selection',
    ) ?? null
  )
}

function buildSelectionContextSection({
  fileTitle,
  contextText,
  selectionMentionable,
}: {
  fileTitle: string
  contextText: string
  selectionMentionable: MentionableBlock
}): string {
  const trimmedTitle = fileTitle.trim()
  const selectedText = selectionMentionable.content.trim()
  const context = contextText.trim()

  if (!selectedText || !context) {
    return ''
  }

  const [before, ...afterParts] = contextText.split(QUICK_ASK_CURSOR_MARKER)
  const after = afterParts.join(QUICK_ASK_CURSOR_MARKER)
  const wrappedSelection = `<selected_text_start>\n${selectionMentionable.content}\n</selected_text_end>`

  const selectionContext =
    afterParts.length > 0 && after.startsWith(selectionMentionable.content)
      ? `${before}${wrappedSelection}${after.slice(selectionMentionable.content.length)}`
      : `${contextText}\n\n${wrappedSelection}`

  const titleSection = trimmedTitle ? `Document title: ${trimmedTitle}\n` : ''

  return `\n\nYou are answering a request about a user-selected passage.

Scope rules:
1. The text between <selected_text_start> and </selected_text_end> is the only target of the user's request.
2. Do not translate, rewrite, summarize, or explain text outside the selected text unless the user explicitly asks for broader context.
3. Use the surrounding text only to understand the selected text.
4. Your output should correspond only to the selected text.
5. If the user's request is ambiguous, assume it applies only to the selected text.

${titleSection}<selection_context path="${selectionMentionable.file.path}">
${selectionContext}
</selection_context>
`
}

function getSelectionEndPosition(
  from: { line: number; ch: number },
  text: string,
): { line: number; ch: number } {
  const lines = text.split('\n')
  if (lines.length <= 1) {
    return {
      line: from.line,
      ch: from.ch + text.length,
    }
  }
  return {
    line: from.line + lines.length - 1,
    ch: lines[lines.length - 1]?.length ?? 0,
  }
}

type QuickAskRunStatus =
  | 'requesting'
  | 'thinking'
  | 'generating'
  | 'modifying'
  | null

type QuickAskPanelProps = {
  plugin: SmartComposerPlugin
  editor: Editor
  view: EditorView
  contextText: string
  fileTitle: string
  sourceFilePath?: string
  initialPrompt?: string
  initialMentionables?: Mentionable[]
  initialMode?: QuickAskLaunchMode
  initialInput?: string
  editContextText?: string
  editSelectionFrom?: { line: number; ch: number }
  selectionScope?: QuickAskSelectionScope
  autoSend?: boolean
  onClose: () => void
  containerRef?: React.RefObject<HTMLDivElement>
  onOverlayStateChange?: (isOverlayActive: boolean) => void
  onDragOffset?: (offsetX: number, offsetY: number) => void
  onResize?: (width: number, height: number) => void
  onDockToTopRight?: () => void
}

function createPlainTextEditorState(text: string): SerializedEditorState {
  const state = {
    root: {
      children: [
        {
          children: [
            {
              detail: 0,
              format: 0,
              mode: 'normal',
              style: '',
              text,
              type: 'text',
              version: 1,
            },
          ],
          direction: 'ltr',
          format: '',
          indent: 0,
          type: 'paragraph',
          version: 1,
        },
      ],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  } as unknown
  return state as SerializedEditorState
}

export function QuickAskPanel({
  plugin,
  editor: _editor,
  view: _view,
  contextText,
  fileTitle,
  sourceFilePath,
  initialPrompt,
  initialMentionables,
  initialMode,
  initialInput,
  editContextText,
  editSelectionFrom,
  selectionScope,
  autoSend,
  onClose,
  containerRef,
  onOverlayStateChange,
  onDragOffset,
  onResize,
  onDockToTopRight,
}: QuickAskPanelProps) {
  const app = useApp()
  const { settings } = useSettings()
  const { setSettings } = useSettings()
  const { t } = useLanguage()
  const { getRAGEngine } = useRAG()
  const { getMcpManager } = useMcp()
  const { createOrUpdateConversationImmediately, generateConversationTitle } =
    useChatHistory()

  const assistants = settings.assistants || []
  const currentAssistantId = settings.quickAskAssistantId

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
  const [runStatus, setRunStatus] = useState<QuickAskRunStatus>(null)
  const [isAssistantMenuOpen, setIsAssistantMenuOpen] = useState(false)
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false)
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false)
  const [isMentionMenuOpen, setIsMentionMenuOpen] = useState(false)
  const [mentionMenuPlacement, setMentionMenuPlacement] = useState<
    'top' | 'bottom'
  >('top')
  const [mentionables, setMentionables] = useState<Mentionable[]>(
    () => initialMentionables ?? [],
  )
  const [activeSelectionScope, setActiveSelectionScope] =
    useState<QuickAskSelectionScope | null>(() => selectionScope ?? null)
  const [isApplying, setIsApplying] = useState(false)
  const [activeApplyRequestKey, setActiveApplyRequestKey] = useState<
    string | null
  >(null)
  const hasDockedRef = useRef(false)
  const enableAutoDock =
    settings.continuationOptions.quickAskAutoDockToTopRight ?? true
  const mentionableUnitLabel = useMemo(
    () => t('common.characters', 'chars'),
    [t],
  )
  const [mode, setMode] = useState<QuickAskMode>(() =>
    normalizeQuickAskVisibleMode(
      initialMode ?? settings.continuationOptions?.quickAskMode,
    ),
  )
  const [executionMode, setExecutionMode] = useState<QuickAskExecutionMode>(
    () =>
      normalizeQuickAskExecutionMode(
        initialMode ?? settings.continuationOptions?.quickAskMode,
      ),
  )
  const assistantDropdownRef = useRef<HTMLDivElement | null>(null)
  const assistantTriggerRef = useRef<HTMLButtonElement | null>(null)
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null)
  const modeTriggerRef = useRef<HTMLButtonElement | null>(null)

  const inputRowRef = useRef<HTMLDivElement | null>(null)
  const contentEditableRef = useRef<HTMLDivElement>(null)
  const chatUserInputRefs = useRef<Map<string, ChatUserInputRef>>(new Map())
  const lexicalEditorRef = useRef<LexicalEditor | null>(null)
  const chatAreaRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const applyAbortControllerRef = useRef<AbortController | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const userDisabledAutoScrollRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const autoSendRef = useRef(false)
  const hasAppliedInitialInputRef = useRef(false)
  const [focusedUserMessageId, setFocusedUserMessageId] = useState<
    string | null
  >(null)

  useEffect(() => {
    if (initialMode) {
      setMode(normalizeQuickAskVisibleMode(initialMode))
      setExecutionMode(normalizeQuickAskExecutionMode(initialMode))
    }
  }, [initialMode])

  useEffect(() => {
    setMentionables(initialMentionables ?? [])
  }, [initialMentionables])

  useEffect(() => {
    setActiveSelectionScope(selectionScope ?? null)
  }, [selectionScope])

  // Drag & Resize state
  const dragHandleRef = useRef<HTMLDivElement>(null)
  const resizeHandlesRef = useRef<{
    right?: HTMLDivElement | null
    bottom?: HTMLDivElement | null
    bottomRight?: HTMLDivElement | null
    bottomLeft?: HTMLDivElement | null
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
    direction: 'right' | 'bottom' | 'bottom-right' | 'bottom-left'
    x: number
    y: number
    width: number
    height: number
    panelX: number
    panelY: number
  } | null>(null)
  const [panelSize, setPanelSize] = useState<{
    width: number
    height: number
  } | null>(null)
  const compactMinHeightRef = useRef<number | null>(null)
  const selectionMentionable = activeSelectionScope?.mentionable ?? null
  const selectionEditContextText =
    activeSelectionScope?.mentionable.content ?? editContextText ?? ''
  const selectionEditFrom =
    activeSelectionScope?.selectionFrom ?? editSelectionFrom
  const hasScopedSelectionForEdit =
    selectionEditContextText.trim().length > 0 && !!selectionEditFrom
  const buildEditInstruction = useCallback(
    (instruction: string) => {
      const context = selectionEditContextText.trim()
      if (!context) return instruction
      return `${instruction}\n\nOnly modify the selected context below. Do not change other parts.\nSelected context:\n${context}`
    },
    [selectionEditContextText],
  )

  useLayoutEffect(() => {
    if (
      chatMessages.length > 0 ||
      panelSize?.height ||
      !containerRef?.current
    ) {
      return
    }

    const rect = containerRef.current.getBoundingClientRect()
    if (!Number.isFinite(rect.height) || rect.height <= 0) return

    compactMinHeightRef.current = rect.height
  }, [chatMessages.length, containerRef, panelSize?.height])

  const resolveEditTargetFile = useCallback(() => {
    if (sourceFilePath) {
      return app.vault.getFileByPath(sourceFilePath)
    }
    return app.workspace.getActiveFile()
  }, [app, sourceFilePath])

  const deriveAskRunStatus = useCallback(
    (
      messages: ChatMessage[],
    ): Exclude<QuickAskRunStatus, 'modifying' | null> => {
      const lastAssistantMessage = [...messages]
        .reverse()
        .find((message): message is ChatAssistantMessage => {
          return message.role === 'assistant'
        })

      if (!lastAssistantMessage) {
        return 'requesting'
      }

      if (lastAssistantMessage.content.trim().length > 0) {
        return 'generating'
      }

      if (lastAssistantMessage.reasoning?.trim().length) {
        return 'thinking'
      }

      return 'requesting'
    },
    [],
  )

  const runStatusLabel = useMemo(() => {
    if (!runStatus) return null
    if (runStatus === 'requesting') {
      return t('quickAsk.statusRequesting', 'Requesting...')
    }
    if (runStatus === 'thinking') {
      return t('quickAsk.statusThinking', 'Thinking...')
    }
    if (runStatus === 'generating') {
      return t('quickAsk.statusGenerating', 'Generating...')
    }
    return t('quickAsk.statusModifying', 'Modifying...')
  }, [runStatus, t])

  const noop = useCallback(() => {}, [])
  const noopSetMentionables = useCallback((_items: Mentionable[]) => {}, [])

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
      const selectionMentionableKey = selectionMentionable
        ? getMentionableKey(serializeMentionable(selectionMentionable))
        : null

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

      if (
        selectionMentionableKey &&
        destroyedMentionableKeys.includes(selectionMentionableKey)
      ) {
        setActiveSelectionScope(null)
      }
    },
    [app, mentionables, selectionMentionable],
  )

  // Build requestContextBuilder with context
  const requestContextBuilder = useMemo(() => {
    const globalSystemPrompt = settings.systemPrompt || ''
    const assistantPrompt = selectedAssistant?.systemPrompt || ''
    const trimmedTitle = fileTitle.trim()
    const hasTitle = trimmedTitle.length > 0
    const hasContext = contextText.trim().length > 0
    const titleSection = hasTitle ? `File title: ${trimmedTitle}\n` : ''
    const promptSelectionMentionable =
      selectionMentionable ?? getSelectionMentionable(mentionables)
    const contextSection =
      promptSelectionMentionable && hasContext
        ? buildSelectionContextSection({
            fileTitle,
            contextText,
            selectionMentionable: promptSelectionMentionable,
          })
        : hasTitle || hasContext
          ? `\n\nThe user is asking a question in the context of their current document.\n${titleSection}${
              hasContext
                ? `Here is the text around the cursor (context). The marker ${QUICK_ASK_CURSOR_MARKER} indicates the cursor position:\n"""\n${contextText}\n"""\n`
                : ''
            }\nAnswer the user's question based on this context when relevant.`
          : ''

    const combinedSystemPrompt =
      `${globalSystemPrompt}\n\n${assistantPrompt}${contextSection}`.trim()

    return new RequestContextBuilder(
      getRAGEngine,
      app,
      {
        ...settings,
        currentAssistantId: selectedAssistant?.id,
        systemPrompt: combinedSystemPrompt,
      },
      {
        includeSkills: executionMode === 'agent',
      },
    )
  }, [
    app,
    contextText,
    executionMode,
    fileTitle,
    getRAGEngine,
    mentionables,
    selectionMentionable,
    selectedAssistant,
    settings,
  ])

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

  const autoScrollToBottom = useCallback(() => {
    if (!chatAreaRef.current || !shouldAutoScrollRef.current) {
      return
    }

    chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight
  }, [])

  const {
    beginBufferedRunnerSession,
    queueBufferedRunnerMessages,
    flushBufferedRunnerMessages,
    getLatestBufferedMessages,
  } = useBufferedRunnerMessages({
    setChatMessages,
    autoScrollToBottom,
  })

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

  const readEditBaseContent = useCallback(
    async (targetFilePath?: string): Promise<string> => {
      const activeFilePath = app.workspace.getActiveFile()?.path
      if (
        targetFilePath &&
        (targetFilePath === sourceFilePath || targetFilePath === activeFilePath)
      ) {
        return _editor.getValue()
      }
      const fallbackFile = targetFilePath
        ? app.vault.getFileByPath(targetFilePath)
        : null
      if (!fallbackFile) {
        return _editor.getValue()
      }
      return readTFileContent(fallbackFile, app.vault)
    },
    [_editor, app, sourceFilePath],
  )

  const buildSelectionScopedContent = useCallback(
    ({
      currentContent,
      selectedContext,
      selectionFrom,
    }: {
      currentContent: string
      selectedContext: string
      selectionFrom?: { line: number; ch: number }
    }): {
      editSourceText: string
      finalContent: string
    } => {
      if (!selectionFrom || selectedContext.trim().length === 0) {
        return {
          editSourceText: currentContent,
          finalContent: currentContent,
        }
      }

      const head = _editor.getRange({ line: 0, ch: 0 }, selectionFrom)
      const tail = currentContent.slice(head.length + selectedContext.length)

      return {
        editSourceText: selectedContext,
        finalContent: head + selectedContext + tail,
      }
    },
    [_editor],
  )

  const generatePlannedEdit = useCallback(
    async ({
      instruction,
      targetFile,
      scopedToSelection,
    }: {
      instruction: string
      targetFile: ReturnType<typeof resolveEditTargetFile>
      scopedToSelection: boolean
    }) => {
      if (!targetFile) {
        return null
      }

      const currentContent = await readEditBaseContent(targetFile.path)
      const selectedContext = selectionEditContextText
      const selectionFrom = scopedToSelection ? selectionEditFrom : undefined
      const scopedContent = buildSelectionScopedContent({
        currentContent,
        selectedContext,
        selectionFrom,
      })

      const plan = await generateEditPlan({
        instruction,
        currentFile: targetFile,
        currentFileContent: scopedContent.editSourceText,
        scopedToSelection,
        providerClient,
        model,
      })

      if (!plan) {
        return {
          currentContent,
          scopedSourceText: scopedContent.editSourceText,
          scopedToSelection,
          selectionFrom,
          selectedContext,
          materialized: null,
        }
      }

      const materialized = materializeTextEditPlan({
        content: scopedContent.editSourceText,
        plan,
      })

      const finalContent = selectionFrom
        ? (() => {
            const head = _editor.getRange({ line: 0, ch: 0 }, selectionFrom)
            const tail = currentContent.slice(
              head.length + scopedContent.editSourceText.length,
            )
            return head + materialized.newContent + tail
          })()
        : materialized.newContent

      return {
        currentContent,
        scopedSourceText: scopedContent.editSourceText,
        scopedToSelection,
        selectionFrom,
        selectedContext,
        materialized: {
          ...materialized,
          finalContent,
        },
      }
    },
    [
      _editor,
      buildSelectionScopedContent,
      selectionEditContextText,
      selectionEditFrom,
      model,
      providerClient,
      readEditBaseContent,
    ],
  )

  useEffect(() => {
    if (hasDockedRef.current) return
    if (!enableAutoDock) return
    if (chatMessages.length === 0) return
    hasDockedRef.current = true
    onDockToTopRight?.()
  }, [chatMessages.length, enableAutoDock, onDockToTopRight])

  // Abort current stream
  const abortStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setIsStreaming(false)
    setRunStatus(null)
  }, [])

  // Submit message
  const submitMessage = useCallback(
    async (
      editorState: SerializedEditorState,
      mentionablesOverride?: Mentionable[],
      options?: {
        baseMessages?: ChatMessage[]
        userMessageId?: string
      },
    ) => {
      if (isStreaming) return

      // Extract text from editor state
      const textContent = editorStateToPlainText(editorState)
      if (!textContent.trim()) return

      setIsStreaming(true)
      setRunStatus('requesting')
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
        id: options?.userMessageId ?? uuidv4(),
        mentionables: mentionablesOverride ?? mentionables,
      }

      // Clear mentionables after creating the message
      setMentionables([])

      const newMessages: ChatMessage[] = [
        ...(options?.baseMessages ?? chatMessages),
        userMessage,
      ]
      setChatMessages(newMessages)
      beginBufferedRunnerSession(newMessages)

      // Create abort controller
      const abortController = new AbortController()
      abortControllerRef.current = abortController
      let unsubscribeRunner: (() => void) | null = null

      try {
        const mcpManager = await getMcpManager()

        const isAgentMode = executionMode === 'agent'
        const effectiveEnableTools = isAgentMode
          ? (selectedAssistant?.enableTools ?? true)
          : false
        const effectiveIncludeBuiltinTools = effectiveEnableTools
          ? (selectedAssistant?.includeBuiltinTools ?? true)
          : false
        const effectiveModel =
          isAgentMode && selectedAssistant
            ? {
                ...model,
                customParameters: mergeCustomParameters(
                  model.customParameters,
                  selectedAssistant.customParameters,
                ),
              }
            : model
        const disabledSkillIds = settings.skills?.disabledSkillIds ?? []
        const enabledSkillEntries =
          isAgentMode && selectedAssistant
            ? listLiteSkillEntries(app, { settings }).filter((skill) =>
                isSkillEnabledForAssistant({
                  assistant: selectedAssistant,
                  skillId: skill.id,
                  disabledSkillIds,
                }),
              )
            : []
        const allowedSkillIds = enabledSkillEntries.map((skill) => skill.id)
        const allowedSkillNames = enabledSkillEntries.map((skill) => skill.name)

        const agentService = plugin.getAgentService()
        unsubscribeRunner = agentService.subscribe(
          conversationId,
          (state) => {
            setRunStatus(deriveAskRunStatus(state.messages))
            queueBufferedRunnerMessages({
              responseMessages: state.messages,
              anchorMessageId: userMessage.id,
              abortController,
            })
          },
          { emitCurrent: false },
        )

        await agentService.run({
          conversationId,
          loopConfig: {
            enableTools: effectiveEnableTools,
            maxAutoIterations: isAgentMode
              ? QUICK_ASK_AGENT_MAX_ITERATIONS
              : QUICK_ASK_CHAT_MAX_ITERATIONS,
            includeBuiltinTools: effectiveIncludeBuiltinTools,
          },
          input: {
            providerClient,
            model: effectiveModel,
            messages: newMessages,
            conversationId,
            requestContextBuilder,
            mcpManager,
            abortSignal: abortController.signal,
            allowedToolNames: effectiveEnableTools
              ? getEnabledAssistantToolNames(selectedAssistant)
              : undefined,
            toolPreferences: selectedAssistant?.toolPreferences,
            allowedSkillIds,
            allowedSkillNames,
            requestParams: {
              stream: true,
            },
            currentFileContextMode: 'summary',
          },
        })

        const finalMessages = flushBufferedRunnerMessages()
        const persistedMessages =
          finalMessages.length > 0 ? finalMessages : getLatestBufferedMessages()

        void (async () => {
          try {
            await createOrUpdateConversationImmediately(
              conversationId,
              persistedMessages,
            )
          } catch (error) {
            console.error('Failed to save quick ask conversation', error)
            return
          }

          try {
            await generateConversationTitle(conversationId, persistedMessages)
          } catch (error) {
            console.error(
              'Failed to generate quick ask conversation title',
              error,
            )
          }
        })()
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          // Aborted by user
          return
        }
        console.error('Quick ask failed:', error)
        new Notice(t('quickAsk.error', 'Failed to generate response'))
      } finally {
        if (unsubscribeRunner) {
          unsubscribeRunner()
        }
        setIsStreaming(false)
        setRunStatus(null)
        abortControllerRef.current = null
      }
    },
    [
      chatMessages,
      conversationId,
      createOrUpdateConversationImmediately,
      deriveAskRunStatus,
      flushBufferedRunnerMessages,
      generateConversationTitle,
      getLatestBufferedMessages,
      getMcpManager,
      isStreaming,
      mentionables,
      beginBufferedRunnerSession,
      executionMode,
      model,
      plugin,
      queueBufferedRunnerMessages,
      requestContextBuilder,
      providerClient,
      app,
      selectedAssistant,
      settings,
      t,
    ],
  )

  const handleToolMessageUpdate = useCallback(
    (toolMessage: ChatToolMessage) => {
      setChatMessages((prev) =>
        prev.map((message) =>
          message.id === toolMessage.id ? toolMessage : message,
        ),
      )
    },
    [],
  )

  const registerChatUserInputRef = useCallback(
    (messageId: string, ref: ChatUserInputRef | null) => {
      if (ref) {
        chatUserInputRefs.current.set(messageId, ref)
        return
      }
      chatUserInputRefs.current.delete(messageId)
    },
    [],
  )

  const handleDeleteGroup = useCallback(
    (messageIds: string[]) => {
      setChatMessages((prev) => {
        const nextMessages = prev.filter(
          (message) => !messageIds.includes(message.id),
        )

        void createOrUpdateConversationImmediately(
          conversationId,
          nextMessages,
        ).catch((error) => {
          console.error(
            'Failed to persist quick ask conversation deletion',
            error,
          )
        })

        return nextMessages
      })
      setFocusedUserMessageId((prev) =>
        prev && messageIds.includes(prev) ? null : prev,
      )
    },
    [conversationId, createOrUpdateConversationImmediately],
  )

  const handleApply = useCallback(
    async (
      blockToApply: string,
      applyRequestKey: string,
      targetFilePath?: string,
    ) => {
      if (isApplying) {
        if (activeApplyRequestKey === applyRequestKey) {
          applyAbortControllerRef.current?.abort()
          applyAbortControllerRef.current = null
          setActiveApplyRequestKey(null)
          setIsApplying(false)
        }
        return
      }

      const abortController = new AbortController()
      applyAbortControllerRef.current = abortController
      setActiveApplyRequestKey(applyRequestKey)
      setIsApplying(true)

      try {
        if (abortController.signal.aborted) {
          throw new DOMException('Apply aborted', 'AbortError')
        }

        const targetFile = targetFilePath
          ? app.vault.getFileByPath(targetFilePath)
          : resolveEditTargetFile()
        if (!targetFile) {
          throw new Error('No file is currently open to apply changes.')
        }

        const targetFileContent = await readTFileContent(targetFile, app.vault)
        const plan = parseTextEditPlan(blockToApply, {
          requireDocumentType: true,
        })

        if (!plan) {
          throw new Error('当前内容不包含可应用的编辑计划。')
        }

        const materialized = materializeTextEditPlan({
          content: targetFileContent,
          plan,
        })

        if (materialized.errors.length > 0) {
          console.warn('[Quick Ask Apply] Some planned edits failed.', {
            filePath: targetFile.path,
            errors: materialized.errors,
          })
        }

        if (materialized.appliedCount === 0) {
          throw new Error('当前编辑计划未匹配到可修改内容，请重新生成。')
        }

        await plugin.openApplyReview({
          file: targetFile,
          originalContent: targetFileContent,
          newContent: materialized.newContent,
          reviewMode: 'full',
        } satisfies ApplyViewState)
      } catch (error) {
        if (
          (error instanceof Error && error.name === 'AbortError') ||
          (error instanceof Error && /abort/i.test(error.message))
        ) {
          return
        }

        if (error instanceof Error) {
          new Notice(error.message)
          console.error('Failed to apply changes in quick ask', error)
          return
        }

        new Notice('Failed to apply changes')
        console.error('Failed to apply changes in quick ask', error)
      } finally {
        applyAbortControllerRef.current = null
        setActiveApplyRequestKey(null)
        setIsApplying(false)
      }
    },
    [activeApplyRequestKey, app, isApplying, plugin, resolveEditTargetFile],
  )

  useEffect(() => {
    if (
      autoSend ||
      hasAppliedInitialInputRef.current ||
      (!initialInput && (initialMentionables?.length ?? 0) === 0)
    ) {
      return
    }

    let cancelled = false
    const applyInitialState = () => {
      if (cancelled || hasAppliedInitialInputRef.current) return
      const editor = lexicalEditorRef.current
      if (!editor) {
        requestAnimationFrame(applyInitialState)
        return
      }

      hasAppliedInitialInputRef.current = true
      editor.update(() => {
        const root = $getRoot()
        root.clear()
        const paragraph = $createParagraphNode()
        root.append(paragraph)
        ;(initialMentionables ?? []).forEach((mentionable) => {
          const mentionNode = $createMentionNode(
            getMentionableName(mentionable, {
              unitLabel: mentionableUnitLabel,
            }),
            serializeMentionable(mentionable),
          )
          paragraph.append(mentionNode)
          paragraph.append($createTextNode(' '))
        })
        if (initialInput) {
          paragraph.append($createTextNode(initialInput))
        }
        paragraph.selectEnd()
      })
      setInputText(initialInput ?? '')
    }

    requestAnimationFrame(applyInitialState)
    return () => {
      cancelled = true
    }
  }, [autoSend, initialInput, initialMentionables, mentionableUnitLabel])

  // Submit edit mode - generate a text edit plan and open ApplyView
  const submitEditMode = useCallback(
    async (instruction: string) => {
      if (isStreaming) return
      if (!instruction.trim()) return
      const resolvedInstruction = buildEditInstruction(instruction.trim())

      const targetFile = resolveEditTargetFile()
      if (!targetFile) {
        new Notice(t('quickAsk.editNoFile', 'Please open a file first'))
        return
      }

      setIsStreaming(true)
      setRunStatus('requesting')

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

      let closedForReview = false
      try {
        const scopedToSelection =
          executionMode === 'edit' && hasScopedSelectionForEdit

        const editResult = await generatePlannedEdit({
          instruction: resolvedInstruction,
          targetFile,
          scopedToSelection,
        })

        setRunStatus('modifying')

        if (!editResult?.materialized) {
          new Notice(
            t('quickAsk.editNoChanges', 'No valid changes returned by model'),
          )
          return
        }

        const { materialized, currentContent, selectionFrom, selectedContext } =
          editResult
        const {
          newContent,
          errors,
          appliedCount,
          operationResults,
          totalOperations,
          finalContent,
        } = materialized

        if (appliedCount === 0) {
          console.error('[QuickAsk Edit] Edit plan did not produce changes.', {
            filePath: targetFile.path,
            operationCount: totalOperations,
            appliedCount,
            errors,
          })
          new Notice(
            t(
              'quickAsk.editNoChanges',
              'Could not apply any changes. The model output may not match the document.',
            ),
          )
          return
        }

        if (errors.length > 0) {
          console.warn('Some planned edits failed:', errors)
        }

        // Close Quick Ask before opening review to avoid layout jump
        setIsStreaming(false)
        setRunStatus(null)
        closedForReview = true
        onClose()

        await plugin.openApplyReview({
          file: targetFile,
          originalContent: currentContent,
          newContent: finalContent,
          reviewMode:
            scopedToSelection && selectionFrom ? 'selection-focus' : undefined,
          selectionRange:
            scopedToSelection && selectionFrom
              ? {
                  from: selectionFrom,
                  to: getSelectionEndPosition(selectionFrom, selectedContext),
                }
              : undefined,
        } satisfies ApplyViewState)
      } catch (error) {
        console.error('Edit mode failed:', error)
        new Notice(t('quickAsk.error', 'Failed to generate edits'))
      } finally {
        if (!closedForReview) {
          setIsStreaming(false)
          setRunStatus(null)
        }
      }
    },
    [
      buildEditInstruction,
      executionMode,
      generatePlannedEdit,
      hasScopedSelectionForEdit,
      isStreaming,
      onClose,
      plugin,
      resolveEditTargetFile,
      t,
    ],
  )

  // Submit edit-direct mode - generate and apply edits directly without confirmation
  const submitEditDirect = useCallback(
    async (instruction: string) => {
      if (isStreaming) return
      if (!instruction.trim()) return
      const resolvedInstruction = buildEditInstruction(instruction.trim())

      const targetFile = resolveEditTargetFile()
      if (!targetFile) {
        new Notice(t('quickAsk.editNoFile', 'Please open a file first'))
        return
      }

      setIsStreaming(true)
      setRunStatus('requesting')

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
        const scopedToSelection =
          executionMode === 'edit-direct' && hasScopedSelectionForEdit

        const editResult = await generatePlannedEdit({
          instruction: resolvedInstruction,
          targetFile,
          scopedToSelection,
        })

        setRunStatus('modifying')

        if (!editResult?.materialized) {
          new Notice(
            t('quickAsk.editNoChanges', 'No valid changes returned by model'),
          )
          return
        }

        const { materialized } = editResult
        const {
          errors,
          appliedCount,
          operationResults,
          totalOperations,
          finalContent,
        } = materialized

        if (appliedCount === 0) {
          console.error(
            '[QuickAsk Edit-Direct] Edit plan did not produce changes.',
            {
              filePath: targetFile.path,
              operationCount: totalOperations,
              appliedCount,
              errors,
            },
          )
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
            `Applied {appliedCount} of {totalEdits} edits. Check console for details.`,
          )
            .replace('{appliedCount}', String(appliedCount))
            .replace('{totalEdits}', String(totalOperations))
          new Notice(partialMessage)
        }

        // Apply changes directly to file
        await app.vault.modify(targetFile, finalContent)

        const successMessage = t(
          'quickAsk.editApplied',
          `Successfully applied {appliedCount} edit(s) to {fileName}`,
        )
          .replace('{appliedCount}', String(appliedCount))
          .replace('{fileName}', targetFile.name)
        new Notice(successMessage)

        // Close Quick Ask
        onClose()
      } catch (error) {
        console.error('Edit-direct mode failed:', error)
        new Notice(t('quickAsk.error', 'Failed to apply edits'))
      } finally {
        setIsStreaming(false)
        setRunStatus(null)
      }
    },
    [
      app,
      buildEditInstruction,
      executionMode,
      generatePlannedEdit,
      hasScopedSelectionForEdit,
      isStreaming,
      onClose,
      resolveEditTargetFile,
      t,
    ],
  )

  useEffect(() => {
    if (!autoSend || autoSendRef.current) return
    const prompt = initialPrompt?.trim()
    if (!prompt) return

    let cancelled = false
    const tryAutoSend = () => {
      if (cancelled || autoSendRef.current) return
      const editor = lexicalEditorRef.current
      if (!editor) {
        requestAnimationFrame(tryAutoSend)
        return
      }

      autoSendRef.current = true

      if (executionMode === 'edit') {
        void submitEditMode(prompt)
        return
      }

      if (executionMode === 'edit-direct') {
        void submitEditDirect(prompt)
        return
      }

      const mentionablesToInsert = initialMentionables ?? []
      if (mentionablesToInsert.length > 0) {
        setMentionables(mentionablesToInsert)
      }

      editor.update(() => {
        const root = $getRoot()
        root.clear()
        const paragraph = $createParagraphNode()
        root.append(paragraph)

        mentionablesToInsert.forEach((mentionable) => {
          const mentionNode = $createMentionNode(
            getMentionableName(mentionable, {
              unitLabel: mentionableUnitLabel,
            }),
            serializeMentionable(mentionable),
          )
          paragraph.append(mentionNode)
          paragraph.append($createTextNode(' '))
        })

        paragraph.append($createTextNode(prompt))
        paragraph.selectEnd()
      })

      const editorState = createPlainTextEditorState(prompt)
      void submitMessage(editorState, mentionablesToInsert)
    }

    requestAnimationFrame(tryAutoSend)
    return () => {
      cancelled = true
    }
  }, [
    autoSend,
    initialMentionables,
    initialPrompt,
    mentionableUnitLabel,
    executionMode,
    submitEditDirect,
    submitEditMode,
    submitMessage,
  ])

  // Handle mode change
  const handleModeChange = useCallback(
    (newMode: QuickAskMode) => {
      setMode(newMode)
      setExecutionMode(newMode)
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

        if (executionMode === 'edit') {
          void submitEditMode(textContent)
        } else if (executionMode === 'edit-direct') {
          void submitEditDirect(textContent)
        } else {
          void submitMessage(editorState)
        }
      }
    },
    [executionMode, submitEditMode, submitEditDirect, submitMessage],
  )

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
  const isResizedEmptyState = !hasMessages && !!panelSize?.height
  const groupedChatMessages: (ChatUserMessage | AssistantToolMessageGroup)[] =
    useMemo(() => groupAssistantAndToolMessages(chatMessages), [chatMessages])

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
      if (isStreaming) {
        event.preventDefault()
        abortStream()
        return
      }
      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [
    abortStream,
    isAssistantMenuOpen,
    isModelMenuOpen,
    isModeMenuOpen,
    isStreaming,
    onClose,
  ])

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
          : direction === 'bottom-left'
            ? 'nesw-resize'
            : 'nwse-resize'

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeStartRef.current || !containerRef?.current) return

      const deltaX = e.clientX - resizeStartRef.current.x
      const deltaY = e.clientY - resizeStartRef.current.y

      let newWidth = resizeStartRef.current.width
      let newHeight = resizeStartRef.current.height
      let newX = resizeStartRef.current.panelX
      const newY = resizeStartRef.current.panelY
      const minHeight = hasMessages
        ? 200
        : (compactMinHeightRef.current ?? resizeStartRef.current.height)

      if (
        resizeStartRef.current.direction === 'right' ||
        resizeStartRef.current.direction === 'bottom-right'
      ) {
        newWidth = Math.max(300, resizeStartRef.current.width + deltaX)
      }
      if (resizeStartRef.current.direction === 'bottom-left') {
        const proposedWidth = resizeStartRef.current.width - deltaX
        newWidth = Math.max(300, proposedWidth)
        newX =
          resizeStartRef.current.panelX +
          (resizeStartRef.current.width - newWidth)
      }
      if (
        resizeStartRef.current.direction === 'bottom' ||
        resizeStartRef.current.direction === 'bottom-right'
      ) {
        newHeight = Math.max(minHeight, resizeStartRef.current.height + deltaY)
      }
      if (resizeStartRef.current.direction === 'bottom-left') {
        newHeight = Math.max(minHeight, resizeStartRef.current.height + deltaY)
      }

      setPanelSize({ width: newWidth, height: newHeight })
      onResize?.(newWidth, newHeight)
      if (
        newX !== resizeStartRef.current.panelX ||
        newY !== resizeStartRef.current.panelY
      ) {
        onDragOffset?.(newX, newY)
      }
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
  }, [hasMessages, isResizing, containerRef, onDragOffset, onResize])

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
    (direction: 'right' | 'bottom' | 'bottom-right' | 'bottom-left') =>
      (e: React.MouseEvent) => {
        if (!containerRef?.current) return

        const rect = containerRef.current.getBoundingClientRect()
        resizeStartRef.current = {
          direction,
          x: e.clientX,
          y: e.clientY,
          width: rect.width,
          height: rect.height,
          panelX: rect.left,
          panelY: rect.top,
        }
        setIsResizing(true)
        e.preventDefault()
        e.stopPropagation()
      },
    [containerRef],
  )

  return (
    <div
      className={`smtcmp-quick-ask-panel ${hasMessages ? 'has-messages' : ''} ${isResizedEmptyState ? 'is-resized-empty' : ''} ${isDragging ? 'is-dragging' : ''} ${isResizing ? 'is-resizing' : ''}`}
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
      <button
        type="button"
        className="smtcmp-quick-ask-close-button"
        onClick={onClose}
        aria-label={t('quickAsk.close', 'Close')}
      >
        <X size={14} />
      </button>

      <div
        ref={dragHandleRef}
        className="smtcmp-quick-ask-drag-handle"
        onMouseDown={handleDragStart}
      >
        <div className="smtcmp-quick-ask-drag-indicator" />
      </div>

      {/* Top: Input row */}
      <div className="smtcmp-quick-ask-input-row" ref={inputRowRef}>
        <div
          className={`smtcmp-quick-ask-input ${isStreaming ? 'is-disabled' : ''}`}
        >
          {!isStreaming && (
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
          )}
          {inputText.length === 0 && !isStreaming && (
            <div className="smtcmp-quick-ask-input-placeholder">
              {t('quickAsk.inputPlaceholder', 'Ask a question...')}
            </div>
          )}
          {isStreaming && runStatusLabel && (
            <div className="smtcmp-quick-ask-run-status" aria-live="polite">
              <span
                className="smtcmp-quick-ask-run-status-dot"
                aria-hidden="true"
              />
              <span>{runStatusLabel}</span>
            </div>
          )}
        </div>
      </div>

      {/* Chat area - only shown when there are messages */}
      {hasMessages && (
        <div
          className="smtcmp-quick-ask-chat-area smtcmp-quick-ask-chat-area--shared"
          ref={chatAreaRef}
          style={panelSize?.height ? { maxHeight: 'none' } : undefined}
        >
          {groupedChatMessages.map((messageOrGroup, index) => {
            if (Array.isArray(messageOrGroup)) {
              return (
                <AssistantToolMessageGroupItem
                  key={messageOrGroup.at(0)?.id}
                  messages={messageOrGroup}
                  conversationId={conversationId}
                  suppressFooter={false}
                  showInlineInfo={false}
                  showInsertAction={false}
                  showCopyAction={true}
                  showBranchAction={false}
                  showEditAction={false}
                  showDeleteAction={true}
                  isApplying={isApplying}
                  activeApplyRequestKey={activeApplyRequestKey}
                  onApply={handleApply}
                  onToolMessageUpdate={handleToolMessageUpdate}
                  onEditStart={noop}
                  onEditCancel={noop}
                  onEditSave={noop}
                  onDeleteGroup={handleDeleteGroup}
                  onBranchGroup={noop}
                />
              )
            }
            return (
              <div
                key={messageOrGroup.id}
                className={`smtcmp-quick-ask-user-message${focusedUserMessageId === messageOrGroup.id ? ' smtcmp-quick-ask-user-message--editing' : ''}`}
              >
                <ChatUserInput
                  ref={(ref) =>
                    registerChatUserInputRef(messageOrGroup.id, ref)
                  }
                  initialSerializedEditorState={messageOrGroup.content}
                  onChange={(content) => {
                    setChatMessages((prev) =>
                      prev.map((message) =>
                        message.role === 'user' &&
                        message.id === messageOrGroup.id
                          ? {
                              ...message,
                              content,
                              promptContent: null,
                            }
                          : message,
                      ),
                    )
                  }}
                  onSubmit={(content) => {
                    if (
                      editorStateToPlainText(content).trim() === '' &&
                      messageOrGroup.mentionables.length === 0
                    ) {
                      return
                    }

                    const baseMessages = groupedChatMessages
                      .slice(0, index)
                      .flatMap((group): ChatMessage[] =>
                        Array.isArray(group) ? group : [group],
                      )

                    void submitMessage(content, messageOrGroup.mentionables, {
                      baseMessages,
                      userMessageId: messageOrGroup.id,
                    })
                    setFocusedUserMessageId(null)
                    requestAnimationFrame(() => {
                      contentEditableRef.current?.focus()
                    })
                  }}
                  onFocus={() => {
                    setFocusedUserMessageId(messageOrGroup.id)
                  }}
                  onBlur={() => {
                    setFocusedUserMessageId((current) =>
                      current === messageOrGroup.id ? null : current,
                    )
                  }}
                  mentionables={messageOrGroup.mentionables ?? []}
                  setMentionables={(nextMentionables) => {
                    setChatMessages((prev) =>
                      prev.map((message) =>
                        message.role === 'user' &&
                        message.id === messageOrGroup.id
                          ? {
                              ...message,
                              mentionables: nextMentionables,
                              promptContent: null,
                            }
                          : message,
                      ),
                    )
                  }}
                  compact={focusedUserMessageId !== messageOrGroup.id}
                  onToggleCompact={() => {
                    setFocusedUserMessageId(messageOrGroup.id)
                    requestAnimationFrame(() => {
                      chatUserInputRefs.current.get(messageOrGroup.id)?.focus()
                    })
                  }}
                  modelId={
                    settings.continuationOptions?.continuationModelId &&
                    settings.chatModels.some(
                      (m) =>
                        m.id ===
                        settings.continuationOptions?.continuationModelId,
                    )
                      ? settings.continuationOptions?.continuationModelId
                      : settings.chatModelId
                  }
                  onModelChange={(modelId) => {
                    void setSettings({
                      ...settings,
                      continuationOptions: {
                        ...settings.continuationOptions,
                        continuationModelId: modelId,
                      },
                    })
                  }}
                  showReasoningSelect={false}
                  showPlaceholder={false}
                />
              </div>
            )
          })}
        </div>
      )}

      {/* Bottom toolbar (Cursor style): assistant selector left, actions right */}
      <div className="smtcmp-quick-ask-toolbar">
        {/* Left: Assistant selector */}
        <div className="smtcmp-quick-ask-toolbar-left">
          <button
            type="button"
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
                    quickAskAssistantId: assistant?.id,
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
              type="button"
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
              type="button"
              className="smtcmp-quick-ask-send-button stop"
              onClick={abortStream}
              aria-label={t('quickAsk.stop', 'Stop')}
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="smtcmp-quick-ask-send-button"
              onClick={() => {
                const lexicalEditor = lexicalEditorRef.current
                if (lexicalEditor) {
                  const editorState = lexicalEditor.getEditorState().toJSON()
                  const textContent = editorStateToPlainText(editorState)

                  if (executionMode === 'edit') {
                    void submitEditMode(textContent)
                  } else if (executionMode === 'edit-direct') {
                    void submitEditDirect(textContent)
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
      <div
        className="smtcmp-quick-ask-resize-handle smtcmp-quick-ask-resize-handle-bottom"
        onMouseDown={handleResizeStart('bottom')}
        ref={(el) => (resizeHandlesRef.current.bottom = el)}
      />
      <div
        className="smtcmp-quick-ask-resize-handle smtcmp-quick-ask-resize-handle-bottom-left"
        onMouseDown={handleResizeStart('bottom-left')}
        ref={(el) => (resizeHandlesRef.current.bottomLeft = el)}
      />
      <div
        className="smtcmp-quick-ask-resize-handle smtcmp-quick-ask-resize-handle-bottom-right"
        onMouseDown={handleResizeStart('bottom-right')}
        ref={(el) => (resizeHandlesRef.current.bottomRight = el)}
      />
    </div>
  )
}
