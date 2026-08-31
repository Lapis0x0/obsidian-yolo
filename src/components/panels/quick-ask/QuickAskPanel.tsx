import { EditorView } from '@codemirror/view'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Popover from '@radix-ui/react-popover'
import { SerializedEditorState } from 'lexical'
import { ChevronDown, ChevronUp, Sparkles, X } from 'lucide-react'
import { Editor, Notice, TFile } from 'obsidian'
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
import { useSettings } from '../../../contexts/settings-context'
import { resolveAssistantTimeContextEnabled } from '../../../core/agent/assistant-capabilities'
import { getEnabledAssistantToolNames } from '../../../core/agent/tool-preferences'
import { materializeTextEditPlan } from '../../../core/edits/textEditEngine'
import { parseTextEditPlan } from '../../../core/edits/textEditPlan'
import { LLMModelNotFoundException } from '../../../core/llm/exception'
import { getChatModelClient } from '../../../core/llm/manager'
import { listLiteSkillEntries } from '../../../core/skills/liteSkills'
import { isSkillEnabledForAssistant } from '../../../core/skills/skillPolicy'
import type {
  QuickAskLaunchMode,
  QuickAskSelectionScope,
} from '../../../features/editor/quick-ask/quickAsk.types'
import { QUICK_ASK_CURSOR_MARKER } from '../../../features/editor/quick-ask/quickAsk.types'
import { selectionHighlightController } from '../../../features/editor/selection-highlight/selectionHighlightController'
import { useChatHistory } from '../../../hooks/useChatHistory'
import { useLiteSkillEntries } from '../../../hooks/useLiteSkillEntries'
import type YoloPlugin from '../../../main'
import type { ApplyViewState } from '../../../types/apply-view.types'
import { Assistant } from '../../../types/assistant.types'
import {
  AssistantToolMessageGroup,
  ChatMessage,
  ChatSelectedSkill,
  ChatToolMessage,
  ChatUserMessage,
} from '../../../types/chat'
import type { ChatTimelineItem } from '../../../types/chat-timeline'
import {
  Mentionable,
  MentionableBlock,
  MentionableFile,
  MentionableFolder,
} from '../../../types/mentionable'
import {
  getDefaultReasoningLevel,
  normalizeStoredReasoningLevel,
} from '../../../types/reasoning'
import type { ToolCallResponse } from '../../../types/tool-call.types'
import { renderAssistantIcon } from '../../../utils/assistant-icon'
import type { EditorSnapshotInjection } from '../../../utils/chat/contextual-injections'
import {
  getMentionableKey,
  serializeMentionable,
} from '../../../utils/chat/mentionable'
import { RequestContextBuilder } from '../../../utils/chat/requestContextBuilder'
import { buildMessageTimelineItems } from '../../../utils/chat/timeline'
import { readTFileContent } from '../../../utils/obsidian'
import { stampUserMessageTimeContext } from '../../../utils/prompt/timeContext'
import { AssistantRenderStreamProvider } from '../../chat-view/assistant-render-stream-context'
import AssistantToolMessageGroupItem from '../../chat-view/AssistantToolMessageGroupItem'
import {
  ChatModeSelect,
  type ChatModeSelectOptionValue,
} from '../../chat-view/chat-input/ChatModeSelect'
import type { ChatUserInputRef } from '../../chat-view/chat-input/ChatUserInput'
import MessageInputCore, {
  type MessageInputCoreRef,
} from '../../chat-view/chat-input/MessageInputCore'
import { ModelSelect } from '../../chat-view/chat-input/ModelSelect'
import {
  type ReasoningLevel,
  ReasoningSelect,
  supportsReasoning,
} from '../../chat-view/chat-input/ReasoningSelect'
import { SubmitButton } from '../../chat-view/chat-input/SubmitButton'
import { editorStateToPlainText } from '../../chat-view/chat-input/utils/editor-state-to-plain-text'
import { resolveChatModeRuntime } from '../../chat-view/chat-runtime-profiles'
import { getChatSurfacePreset } from '../../chat-view/chat-surface-presets'
import { LiveEdgeFollowProvider } from '../../chat-view/live-edge-follow-context'
import { SharedConversationSurface } from '../../chat-view/SharedConversationSurface'
import { useAutoScroll } from '../../chat-view/useAutoScroll'
import {
  useChatTimelineReadModel,
  useStableChatTimelineItems,
} from '../../chat-view/useChatTimelineReadModel'
import UserMessageItem from '../../chat-view/UserMessageItem'
import { YoloDropdownContent, YoloPopoverContent } from '../../common/popover'
import {
  ICON_OPTIONS,
  getDefaultQuickActions,
} from '../../settings/ContinuationQuickActionsSettings'

import { AssistantSelectMenu } from './AssistantSelectMenu'
import { createQuickAskEditorState } from './utils/createQuickAskEditorState'

type QuickAskMode = Extract<
  ChatModeSelectOptionValue,
  'ask' | 'agent' | 'continue'
>

type QuickAskMenuId = 'assistant' | 'model' | 'reasoning' | 'mode' | 'mention'

const quickAskRenderVersionObjectIds = new WeakMap<object, number>()
let nextQuickAskRenderVersionObjectId = 1

function getQuickAskRenderVersionObjectId(
  value: object | null | undefined,
): number {
  if (!value) {
    return 0
  }
  const existing = quickAskRenderVersionObjectIds.get(value)
  if (existing !== undefined) {
    return existing
  }
  const id = nextQuickAskRenderVersionObjectId
  nextQuickAskRenderVersionObjectId += 1
  quickAskRenderVersionObjectIds.set(value, id)
  return id
}

// Accepts loosely-typed input (not just QuickAskLaunchMode) because it also
// normalizes settings.continuationOptions.quickAskMode, whose zod schema
// still accepts legacy 'edit'/'edit-direct' values from old data.json files
// (see setting.types.ts) so that reading a leftover value there doesn't fail
// the whole continuationOptions object's validation.
function normalizeQuickAskVisibleMode(mode?: string | null): QuickAskMode {
  if (mode === 'agent') return 'agent'
  if (mode === 'continue') return 'continue'
  return 'ask'
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

/**
 * QuickAskPanel props use a capabilities discriminated union so that
 * edit-only props (editor, view, selectionScope) are only accessible when
 * capabilities.edit === true. This lets TypeScript enforce that PDF paths
 * cannot accidentally invoke editor methods.
 */
type QuickAskPanelPropsBase = {
  plugin: YoloPlugin
  contextText: string
  fileTitle: string
  sourceFilePath?: string
  initialPrompt?: string
  initialMentionables?: Mentionable[]
  initialMode?: QuickAskLaunchMode
  initialInput?: string
  autoSend?: boolean
  initialAssistantId?: string
  /**
   * One-shot rewrite entry (see QuickAskShowOptions.isRewriteEntry). Ignored
   * when capabilities.edit is false (PDF has no editor to rewrite into).
   */
  isRewriteEntry?: boolean
  onClose: () => void
  messageInputRef?: React.RefObject<MessageInputCoreRef>
  containerRef?: React.RefObject<HTMLDivElement>
  onOverlayStateChange?: (isOverlayActive: boolean) => void
  onDragOffset?: (offsetX: number, offsetY: number) => void
  onResize?: (width: number, height: number) => void
  onDockToTopRight?: () => void
  /**
   * Shared Portal target for this panel's Radix popovers (model/mode/
   * reasoning/assistant/continue-preset menus), owned by QuickAskWidget.
   * It's a sibling of the panel's own animated overlay container rather
   * than a descendant — see the comment in QuickAskWidget.mountOverlay —
   * and gets its own closing fade toggled in lockstep so open popovers
   * don't hang static while the panel fades out around them.
   */
  popoverPortalHost?: HTMLElement | null
}

type QuickAskPanelProps =
  | (QuickAskPanelPropsBase & {
      capabilities: { edit: true }
      editor: Editor
      view: EditorView
      selectionScope?: QuickAskSelectionScope
    })
  | (QuickAskPanelPropsBase & {
      capabilities: { edit: false }
      editor: null
      view: null
    })

export function QuickAskPanel({
  plugin,
  capabilities,
  editor: _editor,
  view: _view,
  contextText,
  fileTitle,
  sourceFilePath,
  initialPrompt,
  initialMentionables,
  initialMode,
  initialInput,
  autoSend,
  initialAssistantId,
  isRewriteEntry,
  onClose,
  messageInputRef: externalMessageInputRef,
  containerRef,
  onOverlayStateChange,
  onDragOffset,
  onResize,
  onDockToTopRight,
  popoverPortalHost,
  ...editProps
}: QuickAskPanelProps) {
  const selectionScope = capabilities.edit
    ? (editProps as { selectionScope?: QuickAskSelectionScope }).selectionScope
    : undefined
  const quickAskSurfacePreset = getChatSurfacePreset('quick-ask')
  const app = useApp()
  const { settings } = useSettings()
  const { setSettings } = useSettings()
  const { t } = useLanguage()
  const { getMcpManager } = useMcp()
  const { createOrUpdateConversationImmediately, generateConversationTitle } =
    useChatHistory()

  const assistants = settings.assistants || []
  const currentAssistantId = settings.quickAskAssistantId

  // State
  // initialAssistantId (e.g. from a selection chat shortcut) is a one-shot
  // override and takes precedence over the persisted quickAskAssistantId, but
  // we do NOT write it back to settings — the user's persisted preference is
  // preserved for future Quick Ask sessions. If the override does not match a
  // known assistant (e.g. it was deleted), fall back to the persisted choice.
  const [selectedAssistant, setSelectedAssistant] = useState<Assistant | null>(
    () => {
      const overrideAssistant = initialAssistantId
        ? assistants.find((a) => a.id === initialAssistantId)
        : null
      if (overrideAssistant) return overrideAssistant
      if (currentAssistantId) {
        return assistants.find((a) => a.id === currentAssistantId) || null
      }
      return null
    },
  )
  const [conversationId] = useState(() => uuidv4())
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [inputText, setInputText] = useState('')
  const [selectedSkills, setSelectedSkills] = useState<ChatSelectedSkill[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  // While the LLM is streaming, flip the QuickAsk-owned selection highlight
  // into a "pending" shimmer so users get visible feedback that AI is working
  // on the selected text. The highlight itself is created/cleared by
  // QuickAskController; we only flip its visual state here.
  useEffect(() => {
    selectionHighlightController.updateVisualByOwner(
      'quickask',
      isStreaming ? 'pending' : 'selection',
    )
    return () => {
      selectionHighlightController.updateVisualByOwner('quickask', 'selection')
    }
  }, [isStreaming])
  // Single source of truth for which transient menus are open. Each menu
  // reports open/close under its own id, so a close event from one menu can
  // never stomp another menu's open state regardless of event ordering.
  const [openMenus, setOpenMenus] = useState<ReadonlySet<QuickAskMenuId>>(
    () => new Set(),
  )
  const setMenuOpen = useCallback((menu: QuickAskMenuId, open: boolean) => {
    setOpenMenus((prev) => {
      if (prev.has(menu) === open) return prev
      const next = new Set(prev)
      if (open) {
        next.add(menu)
      } else {
        next.delete(menu)
      }
      return next
    })
  }, [])
  const isAssistantMenuOpen = openMenus.has('assistant')
  const isModelMenuOpen = openMenus.has('model')
  const isReasoningMenuOpen = openMenus.has('reasoning')
  const isModeMenuOpen = openMenus.has('mode')
  const isMentionMenuOpen = openMenus.has('mention')
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
  const mentionableUnitLabels = useMemo(
    () => ({
      characters: t('common.characters', 'chars'),
      words: t('common.words', 'words'),
      wordsCharacters: t('common.wordsCharacters', 'words/chars'),
      rows: t('common.rows', 'rows'),
      columns: t('common.columns', 'columns'),
    }),
    [t],
  )
  const initialSerializedEditorState = useMemo(() => {
    if (autoSend) return null
    if (!initialInput && (initialMentionables?.length ?? 0) === 0) {
      return null
    }
    return createQuickAskEditorState({
      prompt: initialInput ?? '',
      mentionables: initialMentionables ?? [],
      mentionableUnitLabels,
    })
  }, [autoSend, initialInput, initialMentionables, mentionableUnitLabels])

  useEffect(() => {
    if (initialSerializedEditorState) {
      latestEditorStateRef.current = initialSerializedEditorState
    }
  }, [initialSerializedEditorState])

  // "continue" mode needs an editor to write into (see QuickAskPanel props'
  // capabilities discriminated union) — PDF panels have capabilities.edit
  // === false, so a persisted or one-shot 'continue' mode always falls back
  // to 'ask' there.
  const clampQuickAskMode = useCallback(
    (value: QuickAskMode): QuickAskMode =>
      value === 'continue' && !capabilities.edit ? 'ask' : value,
    [capabilities.edit],
  )
  const [mode, setMode] = useState<QuickAskMode>(() =>
    clampQuickAskMode(
      normalizeQuickAskVisibleMode(
        initialMode ?? settings.continuationOptions?.quickAskMode,
      ),
    ),
  )
  const [yoloEnabled, setYoloEnabled] = useState(
    () => settings.chatOptions.agentYoloEnabled ?? false,
  )
  // One-shot rewrite entry (see QuickAskShowOptions.isRewriteEntry). PDF
  // panels have no editor to rewrite into, so the entry never applies there.
  const [isRewriteIntent, setIsRewriteIntent] = useState<boolean>(
    () => capabilities.edit && Boolean(isRewriteEntry),
  )
  const assistantTriggerRef = useRef<HTMLButtonElement | null>(null)
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null)
  const reasoningTriggerRef = useRef<HTMLButtonElement | null>(null)
  const modeTriggerRef = useRef<HTMLButtonElement | null>(null)
  const inputRowRef = useRef<HTMLDivElement | null>(null)
  const internalMessageInputRef = useRef<MessageInputCoreRef>(null)
  const messageInputRef = externalMessageInputRef ?? internalMessageInputRef
  const latestEditorStateRef = useRef<SerializedEditorState | null>(null)
  const chatUserInputRefs = useRef<Map<string, ChatUserInputRef>>(new Map())
  const chatAreaRef = useRef<HTMLDivElement>(null)
  const [chatAreaElement, setChatAreaElement] = useState<HTMLElement | null>(
    null,
  )
  const [chatBottomSentinelElement, setChatBottomSentinelElement] =
    useState<HTMLElement | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const applyAbortControllerRef = useRef<AbortController | null>(null)
  const autoSendRef = useRef(false)
  const selectionRewriteStartedRef = useRef(false)
  const continueSubmitStartedRef = useRef(false)
  const [focusedUserMessageId, setFocusedUserMessageId] = useState<
    string | null
  >(null)
  const suppressNextFocusedUserMessageOutsidePointerRef = useRef<string | null>(
    null,
  )

  useEffect(() => {
    if (initialMode) {
      setMode(clampQuickAskMode(normalizeQuickAskVisibleMode(initialMode)))
    }
    setIsRewriteIntent(capabilities.edit && Boolean(isRewriteEntry))
  }, [capabilities.edit, clampQuickAskMode, initialMode, isRewriteEntry])

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
  const selectionRewriteContextText =
    activeSelectionScope?.mentionable.content ?? ''
  const selectionRewriteFrom = activeSelectionScope?.selectionFrom
  const hasScopedSelectionForRewrite =
    selectionRewriteContextText.trim().length > 0 && !!selectionRewriteFrom
  const isTemporaryRewriteMode = isRewriteIntent && hasScopedSelectionForRewrite
  const modeTriggerLabel = isTemporaryRewriteMode
    ? t('chatMode.rewrite', '改写')
    : undefined

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

  const allSkillEntries = useLiteSkillEntries(app, { settings })
  const availableSkills = useMemo(() => {
    if (!selectedAssistant) {
      return []
    }

    const disabledSkillNames = settings.skills?.disabledSkillIds ?? []
    return allSkillEntries.filter((skill) =>
      isSkillEnabledForAssistant({
        assistant: selectedAssistant,
        skillName: skill.name,
        disabledSkillNames,
        defaultLoadMode: skill.mode,
      }),
    )
  }, [allSkillEntries, selectedAssistant, settings])

  const enabledChatModels = useMemo(
    () => settings.chatModels.filter((chatModel) => chatModel.enable ?? true),
    [settings.chatModels],
  )

  // Quick-action chips for "continue" mode, sourced from the same presets
  // the settings page lets users customize. Clicking a chip submits
  // immediately with that instruction, ignoring whatever is currently typed
  // — mirrors the old Smart Space panel's quick-action click behavior.
  const isContinueMode = mode === 'continue' && capabilities.edit
  // PDF panels (capabilities.edit === false) have no editor to write into.
  const continueQuickActions = useMemo(() => {
    if (!isContinueMode) return []
    const configured = settings.continuationOptions?.continuationQuickActions
    const actions =
      configured && configured.length > 0
        ? configured
        : getDefaultQuickActions(t)
    return actions.filter((action) => action.enabled)
  }, [
    isContinueMode,
    settings.continuationOptions?.continuationQuickActions,
    t,
  ])

  // Preset menu floats below the composer as a Quick-Ask-style popover; it is
  // the idle-state default, so it yields as soon as the user starts writing
  // an instruction or opens any other menu.
  const showContinueActionsMenu =
    isContinueMode &&
    continueQuickActions.length > 0 &&
    !isStreaming &&
    inputText.length === 0 &&
    openMenus.size === 0

  const focusFirstContinueAction = useCallback(() => {
    const ownerDocument = modeTriggerRef.current?.ownerDocument ?? document
    const firstAction = ownerDocument.querySelector<HTMLButtonElement>(
      '.yolo-quick-ask-continue-menu-item',
    )
    if (!firstAction) return false
    firstAction.focus()
    return true
  }, [])

  const handleContinueMenuKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const items = Array.from(
        event.currentTarget.querySelectorAll<HTMLButtonElement>(
          '.yolo-quick-ask-continue-menu-item',
        ),
      )
      if (items.length === 0) return
      const ownerDocument = event.currentTarget.ownerDocument
      const currentIndex = items.findIndex(
        (item) => item === ownerDocument.activeElement,
      )

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        items[(currentIndex + 1) % items.length]?.focus()
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (currentIndex <= 0) {
          modeTriggerRef.current?.focus()
          return
        }
        items[currentIndex - 1]?.focus()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        modeTriggerRef.current?.focus()
      }
    },
    [],
  )

  const canSubmitMainInput =
    inputText.trim().length > 0 ||
    mentionables.length > 0 ||
    selectedSkills.length > 0

  const noop = useCallback(() => {}, [])
  const handleOpenEditSummaryFile = useCallback(
    ({ path }: { path: string }) => {
      const targetFile = app.vault.getAbstractFileByPath(path)
      if (!(targetFile instanceof TFile)) {
        new Notice(t('chat.editSummary.fileMissing', '文件不存在或已被移动。'))
        return
      }

      const leaf = app.workspace.getLeaf(false)
      void leaf.openFile(targetFile)
    },
    [app.vault, app.workspace, t],
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

  // Clear selection scope when its mentionable is removed from the input.
  useEffect(() => {
    if (!selectionMentionable) return
    const selectionKey = getMentionableKey(
      serializeMentionable(selectionMentionable),
    )
    const stillPresent = mentionables.some(
      (mentionable) =>
        getMentionableKey(serializeMentionable(mentionable)) === selectionKey,
    )
    if (!stillPresent) {
      setActiveSelectionScope(null)
    }
  }, [mentionables, selectionMentionable])

  // System prompt is intentionally minimal: Quick Ask's "current editor scene"
  // (file path/title, cursor context, selection) is injected via the agent
  // runtime's `contextualInjections` channel — see editorSnapshotInjection
  // built below in the submit path.
  const requestContextBuilder = useMemo(() => {
    const globalSystemPrompt = settings.systemPrompt || ''
    const assistantPrompt = selectedAssistant?.systemPrompt || ''
    const combinedSystemPrompt =
      `${globalSystemPrompt}\n\n${assistantPrompt}`.trim()

    return new RequestContextBuilder(
      app,
      {
        ...settings,
        currentAssistantId: selectedAssistant?.id,
        systemPrompt: combinedSystemPrompt,
      },
      {
        includeSkills: mode === 'agent' || mode === 'ask',
        systemPromptSnapshotStore: plugin
          .getAgentService()
          .getSystemPromptSnapshotStore(),
        getPromptSourceRevision: () =>
          plugin.getAgentService().getPromptSourceWatcher().getRevision(),
        promptSourcePathsCallback: (paths) =>
          plugin
            .getAgentService()
            .getPromptSourceWatcher()
            .setWatchedPaths(paths),
      },
    )
  }, [app, mode, selectedAssistant, settings, plugin])

  const editorSnapshotInjection =
    useMemo<EditorSnapshotInjection | null>(() => {
      const trimmedTitle = fileTitle.trim()
      const trimmedPath = sourceFilePath?.trim() ?? ''
      const hasContext = contextText.trim().length > 0
      const promptSelectionMentionable =
        selectionMentionable ?? getSelectionMentionable(mentionables)
      const hasSelection = Boolean(
        promptSelectionMentionable?.content.trim().length,
      )

      if (!trimmedTitle && !trimmedPath && !hasContext && !hasSelection) {
        return null
      }

      return {
        type: 'editor-snapshot',
        filePath: trimmedPath,
        fileTitle: trimmedTitle,
        contextText,
        cursorMarker: QUICK_ASK_CURSOR_MARKER,
        selection: promptSelectionMentionable
          ? {
              content: promptSelectionMentionable.content,
              filePath: promptSelectionMentionable.file.path,
            }
          : undefined,
      }
    }, [
      contextText,
      fileTitle,
      mentionables,
      selectionMentionable,
      sourceFilePath,
    ])

  const { autoScrollToBottom, forceScrollToBottom, isAutoFollowEnabled } =
    useAutoScroll({
      scrollContainerRef: chatAreaRef,
      scrollContainerElement: chatAreaElement,
      bottomSentinelElement: chatBottomSentinelElement,
      followKey: conversationId,
    })
  useLayoutEffect(() => {
    autoScrollToBottom()
  }, [autoScrollToBottom, chatMessages])

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
    onOverlayStateChange?.(openMenus.size > 0)
  }, [openMenus, onOverlayStateChange])

  // Arrow keys focus the first toolbar control (mode); Enter on the trigger
  // will open the menu.
  const handlePanelKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return
      if (
        isAssistantMenuOpen ||
        isModelMenuOpen ||
        isReasoningMenuOpen ||
        isModeMenuOpen
      ) {
        return
      }
      const active = document.activeElement
      if (
        (active && assistantTriggerRef.current?.contains(active)) ||
        (active && modelTriggerRef.current?.contains(active)) ||
        (active && modeTriggerRef.current?.contains(active)) ||
        (active && inputRowRef.current?.contains(active))
      ) {
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      event.stopPropagation()
      modeTriggerRef.current?.focus()
    },
    [isAssistantMenuOpen, isModelMenuOpen, isReasoningMenuOpen, isModeMenuOpen],
  )

  // When focus在模式按钮但菜单未展开时，ArrowUp 将焦点送回输入框（兜底）
  useEffect(() => {
    const handleArrowUpBack = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowUp') return
      if (isAssistantMenuOpen) return
      const active = document.activeElement
      if (active !== modeTriggerRef.current) return
      event.preventDefault()
      event.stopPropagation()
      messageInputRef.current?.focus()
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
      setMenuOpen('assistant', false)
      requestAnimationFrame(() => {
        messageInputRef.current?.focus()
      })
    }
    window.addEventListener('keydown', handleMenuEscape, true)
    return () => window.removeEventListener('keydown', handleMenuEscape, true)
  }, [isAssistantMenuOpen, setMenuOpen])

  // Get model client
  const modelClient = useMemo((): ReturnType<
    typeof getChatModelClient
  > | null => {
    const continuationModelId =
      settings.continuationOptions?.continuationModelId
    const preferredModelId =
      continuationModelId &&
      settings.chatModels.some((m) => m.id === continuationModelId)
        ? continuationModelId
        : settings.chatModelId

    try {
      return getChatModelClient({ settings, modelId: preferredModelId })
    } catch (error) {
      if (error instanceof LLMModelNotFoundException) {
        if (settings.chatModels.length > 0) {
          return getChatModelClient({
            settings,
            modelId: settings.chatModels[0].id,
          })
        }
        return null
      }
      throw error
    }
  }, [settings])
  const providerClient = modelClient?.providerClient
  const model = modelClient?.model
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>('auto')

  useEffect(() => {
    const remembered = model
      ? normalizeStoredReasoningLevel(
          settings.chatOptions.reasoningLevelByModelId?.[model.id],
        )
      : null
    setReasoningLevel(remembered ?? getDefaultReasoningLevel(model ?? null))
    // Only re-derive when the resolved model changes — this must not react
    // to every settings update, or persisting the user's own pick below
    // would immediately re-trigger this effect via the changed
    // reasoningLevelByModelId reference.
  }, [model?.id])

  const handleReasoningLevelChange = useCallback(
    (level: ReasoningLevel) => {
      setReasoningLevel(level)
      if (!model?.id) return
      if (settings.chatOptions.reasoningLevelByModelId?.[model.id] === level) {
        return
      }
      void setSettings({
        ...settings,
        chatOptions: {
          ...settings.chatOptions,
          reasoningLevelByModelId: {
            ...settings.chatOptions.reasoningLevelByModelId,
            [model.id]: level,
          },
        },
      })
    },
    [model, settings, setSettings],
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
    plugin.getAgentService().abortConversation(conversationId)
    setIsStreaming(false)
  }, [conversationId, plugin])

  // Submit message
  const submitMessage = useCallback(
    async (
      editorState: SerializedEditorState,
      mentionablesOverride?: Mentionable[],
      options?: {
        baseMessages?: ChatMessage[]
        userMessageId?: string
        selectedSkillsOverride?: ChatSelectedSkill[]
      },
    ) => {
      if (isStreaming) return

      if (!providerClient || !model) {
        new Notice(
          t(
            'quickAsk.noModelConfigured',
            'No chat model configured. Please add a model in settings.',
          ),
        )
        return
      }

      const resolvedMentionables = mentionablesOverride ?? mentionables
      const resolvedSelectedSkills =
        options?.selectedSkillsOverride ?? selectedSkills

      // Extract text from editor state
      const textContent = editorStateToPlainText(editorState)
      if (
        !textContent.trim() &&
        resolvedMentionables.length === 0 &&
        resolvedSelectedSkills.length === 0
      ) {
        return
      }

      setIsStreaming(true)
      setInputText('')
      forceScrollToBottom()

      messageInputRef.current?.replaceText('')
      latestEditorStateRef.current = null

      // 新用户回合进入对话:在此固定当前时间(与侧边栏 Chat 同一机制)。
      const userMessage: ChatUserMessage = stampUserMessageTimeContext(
        {
          role: 'user',
          content: editorState,
          promptContent: null,
          id: options?.userMessageId ?? uuidv4(),
          mentionables: resolvedMentionables,
          selectedSkills: resolvedSelectedSkills,
          reasoningLevel,
        },
        resolveAssistantTimeContextEnabled(selectedAssistant, settings),
      )

      // Clear mentionables / skills after creating the message
      setMentionables([])
      setSelectedSkills([])

      const newMessages: ChatMessage[] = [
        ...(options?.baseMessages ?? chatMessages),
        userMessage,
      ]
      setChatMessages(newMessages)

      // Set up the abort controller before any awaits so that abortStream()
      // works while we're still compiling mentionables.
      const abortController = new AbortController()
      abortControllerRef.current = abortController
      let unsubscribeRunner: (() => void) | null = null

      // Compile mentionables into promptContent up front so the title model
      // and the chat model see the same expanded context. Mirrors Chat.tsx.
      let compiledMessages: ChatMessage[] = newMessages
      try {
        const { promptContent } =
          await requestContextBuilder.compileUserMessagePrompt({
            message: userMessage,
          })
        const compiledUserMessage: ChatUserMessage = {
          ...userMessage,
          promptContent,
        }
        compiledMessages = [
          ...(options?.baseMessages ?? chatMessages),
          compiledUserMessage,
        ]
      } catch (error) {
        console.error('Failed to compile quick ask user message prompt', error)
      }

      if (abortController.signal.aborted) {
        // Only clear shared state if we still own it — a follow-up submit may
        // have already replaced the controller while we were compiling.
        if (abortControllerRef.current === abortController) {
          setIsStreaming(false)
          abortControllerRef.current = null
        }
        return
      }

      void (async () => {
        try {
          await createOrUpdateConversationImmediately(
            conversationId,
            compiledMessages,
          )
        } catch (error) {
          console.error('Failed to save quick ask conversation', error)
          return
        }

        try {
          await generateConversationTitle(conversationId, compiledMessages)
        } catch (error) {
          console.error(
            'Failed to generate quick ask conversation title',
            error,
          )
        }
      })()

      try {
        const mcpManager = await getMcpManager()

        const isAgentMode = mode === 'agent'
        const chatModeRuntime = resolveChatModeRuntime({
          mode: isAgentMode ? 'agent' : 'ask',
          yoloEnabled,
          assistant: selectedAssistant,
          assistantEnabledToolNames:
            getEnabledAssistantToolNames(selectedAssistant),
        })
        const effectiveModel = model
        const disabledSkillNames = settings.skills?.disabledSkillIds ?? []
        const enabledSkillEntries = selectedAssistant
          ? (await listLiteSkillEntries(app, { settings })).filter((skill) =>
              isSkillEnabledForAssistant({
                assistant: selectedAssistant,
                skillName: skill.name,
                disabledSkillNames,
              }),
            )
          : []
        const allowedSkillPaths = enabledSkillEntries.map((skill) => skill.path)

        const agentService = plugin.getAgentService()
        unsubscribeRunner = agentService.subscribe(
          conversationId,
          (state) => {
            setChatMessages(state.messages)
          },
          { emitCurrent: false },
        )

        await agentService.run({
          conversationId,
          loopConfig: chatModeRuntime.loopConfig,
          input: {
            providerClient,
            model: effectiveModel,
            reasoningLevel,
            messages: compiledMessages,
            conversationId,
            requestContextBuilder,
            mcpManager,
            abortSignal: abortController.signal,
            allowedToolNames: chatModeRuntime.allowedToolNames,
            enableToolDisclosure: settings.mcp.enableToolDisclosure,
            toolPreferences: chatModeRuntime.toolPreferences,
            builtinCapabilityPreferences:
              chatModeRuntime.builtinCapabilityPreferences,
            toolServerPreferences: chatModeRuntime.toolServerPreferences,
            allowedSkillPaths,
            toolCapabilityMode: chatModeRuntime.toolCapabilityMode,
            contextualInjections: editorSnapshotInjection
              ? [editorSnapshotInjection]
              : [],
            requestParams: {
              deliveryMode: 'incremental',
              primaryRequestTimeoutMs:
                settings.continuationOptions.primaryRequestTimeoutMs,
              streamFallbackRecoveryEnabled:
                settings.continuationOptions.streamFallbackRecoveryEnabled,
            },
          },
        })

        const persistedMessages = agentService.getState(conversationId).messages

        void (async () => {
          try {
            await createOrUpdateConversationImmediately(
              conversationId,
              persistedMessages,
            )
          } catch (error) {
            console.error('Failed to save quick ask conversation', error)
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
        abortControllerRef.current = null
      }
    },
    [
      chatMessages,
      conversationId,
      createOrUpdateConversationImmediately,
      generateConversationTitle,
      getMcpManager,
      isStreaming,
      mentionables,
      selectedSkills,
      mode,
      forceScrollToBottom,
      model,
      plugin,
      requestContextBuilder,
      providerClient,
      app,
      selectedAssistant,
      settings,
      t,
      yoloEnabled,
      reasoningLevel,
      editorSnapshotInjection,
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

  const handleToolCallResponseUpdate = useCallback(
    (toolMessageId: string, toolCallId: string, response: ToolCallResponse) => {
      setChatMessages((prev) =>
        prev.map((message) => {
          if (message.id !== toolMessageId || message.role !== 'tool') {
            return message
          }

          let didChange = false
          const nextToolCalls = message.toolCalls.map((toolCall) => {
            if (toolCall.request.id !== toolCallId) {
              return toolCall
            }
            if (toolCall.response === response) {
              return toolCall
            }
            didChange = true
            return { ...toolCall, response }
          })

          return didChange ? { ...message, toolCalls: nextToolCalls } : message
        }),
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

  useEffect(() => {
    if (!focusedUserMessageId) {
      suppressNextFocusedUserMessageOutsidePointerRef.current = null
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      if (target.closest('.yolo-popover-surface')) {
        return
      }

      const activeMessageElement = chatAreaRef.current?.querySelector(
        `[data-user-message-id="${focusedUserMessageId}"]`,
      )
      if (activeMessageElement?.contains(target)) {
        return
      }

      if (
        suppressNextFocusedUserMessageOutsidePointerRef.current ===
        focusedUserMessageId
      ) {
        suppressNextFocusedUserMessageOutsidePointerRef.current = null
        return
      }

      setFocusedUserMessageId(null)
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [focusedUserMessageId])

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
          reviewEdits: materialized.reviewEdits,
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

  // Submit a one-shot rewrite entry: hands off to
  // plugin.startSelectionRewrite, scoped to the selection captured when the
  // panel opened. If that selection is no longer valid (e.g. its mentionable
  // chip was removed from the input), surface a Notice and keep the panel
  // open rather than falling back to any whole-document edit.
  const submitRewrite = useCallback(
    (instruction: string) => {
      if (isStreaming) return
      if (!instruction.trim()) return

      if (!providerClient || !model) {
        new Notice(
          t(
            'quickAsk.noModelConfigured',
            'No chat model configured. Please add a model in settings.',
          ),
        )
        return
      }

      if (
        !capabilities.edit ||
        !_editor ||
        !_view ||
        !hasScopedSelectionForRewrite ||
        !selectionRewriteFrom
      ) {
        new Notice(
          t('quickAsk.rewriteSelectionExpired', '选区已失效，请重新选择文本。'),
        )
        return
      }

      if (selectionRewriteStartedRef.current) return
      selectionRewriteStartedRef.current = true
      const from = _editor.posToOffset(selectionRewriteFrom)
      plugin.startSelectionRewrite({
        view: _view,
        from,
        to: from + selectionRewriteContextText.length,
        selectedText: selectionRewriteContextText,
        instruction: instruction.trim(),
        providerClient,
        model,
        settings,
      })
      selectionHighlightController.clearByOwner('quickask')
      onClose()
    },
    [
      capabilities.edit,
      hasScopedSelectionForRewrite,
      isStreaming,
      _editor,
      _view,
      model,
      onClose,
      plugin,
      providerClient,
      selectionRewriteContextText,
      selectionRewriteFrom,
      settings,
      t,
    ],
  )

  // Submit the "continue" mode: hands off to plugin.continueWriting, scoped
  // to the current editor cursor/selection, using this panel's own resolved
  // providerClient/model (the same one the ask/agent path uses — see
  // `modelClient` above). Unlike ask/agent, an empty instruction is valid
  // here (pure continuation), and the panel closes immediately — feedback
  // from then on is the editor's own thinking indicator + ghost text.
  const submitContinue = useCallback(
    (instructionOverride?: string) => {
      if (isStreaming || continueSubmitStartedRef.current) return
      if (!capabilities.edit || !_editor) return

      if (!providerClient || !model) {
        new Notice(
          t(
            'quickAsk.noModelConfigured',
            'No chat model configured. Please add a model in settings.',
          ),
        )
        return
      }

      continueSubmitStartedRef.current = true
      const instruction = (instructionOverride ?? inputText).trim()
      const continuationMentionables = mentionables.filter(
        (mentionable): mentionable is MentionableFile | MentionableFolder =>
          mentionable.type === 'file' || mentionable.type === 'folder',
      )

      void plugin
        .continueWriting(
          _editor,
          instruction.length > 0 ? instruction : undefined,
          continuationMentionables,
          { providerClient, model },
        )
        .catch((error: unknown) => {
          console.error('Quick ask continue writing failed:', error)
        })

      onClose()
    },
    [
      capabilities.edit,
      inputText,
      isStreaming,
      mentionables,
      model,
      onClose,
      plugin,
      providerClient,
      t,
      _editor,
    ],
  )

  useEffect(() => {
    if (!autoSend || autoSendRef.current) return
    const prompt = initialPrompt?.trim()
    if (!prompt) return

    autoSendRef.current = true

    if (isRewriteIntent) {
      submitRewrite(prompt)
      return
    }

    const mentionablesToInsert = initialMentionables ?? []
    if (mentionablesToInsert.length > 0) {
      setMentionables(mentionablesToInsert)
    }

    const editorState = createQuickAskEditorState({
      prompt,
      mentionables: mentionablesToInsert,
      mentionableUnitLabels,
    })
    latestEditorStateRef.current = editorState
    void submitMessage(editorState, mentionablesToInsert)
  }, [
    autoSend,
    initialMentionables,
    initialPrompt,
    mentionableUnitLabels,
    isRewriteIntent,
    submitRewrite,
    submitMessage,
  ])

  // Handle mode change — switching to Ask/Agent/Write from the dropdown
  // always exits a one-shot rewrite entry; the rewrite intent itself is
  // never persisted to settings.
  const handleModeChange = useCallback(
    (newMode: QuickAskMode) => {
      const clamped = clampQuickAskMode(newMode)
      setMode(clamped)
      setIsRewriteIntent(false)
      void setSettings({
        ...settings,
        continuationOptions: {
          ...settings.continuationOptions,
          quickAskMode: clamped,
        },
      })
    },
    [clampQuickAskMode, setSettings, settings],
  )

  const handleYoloChange = useCallback(
    (enabled: boolean) => {
      setYoloEnabled(enabled)
      void setSettings({
        ...settings,
        chatOptions: {
          ...settings.chatOptions,
          agentYoloEnabled: enabled,
        },
      })
    },
    [setSettings, settings],
  )

  const handleMainInputChange = useCallback(
    (content: SerializedEditorState) => {
      latestEditorStateRef.current = content
    },
    [],
  )

  // Handle Enter key / submit from MessageInputCore
  const handleEnter = useCallback(() => {
    if (isRewriteIntent) {
      const editorState = latestEditorStateRef.current
      if (!editorState) return
      submitRewrite(editorStateToPlainText(editorState))
      return
    }

    if (mode === 'continue') {
      submitContinue()
      return
    }

    const editorState = latestEditorStateRef.current
    if (!editorState) return
    void submitMessage(editorState)
  }, [isRewriteIntent, mode, submitContinue, submitRewrite, submitMessage])

  // Open in sidebar
  const hasMessages = chatMessages.length > 0
  const isResizedEmptyState = !hasMessages && !!panelSize?.height
  const chatTimelineReadModel = useChatTimelineReadModel({
    messages: chatMessages,
  })
  const groupedChatMessages = chatTimelineReadModel.groupedChatMessages
  const activeStreamingMessageId = useMemo(() => {
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      const message = chatMessages[index]
      if (
        message.role === 'assistant' &&
        message.metadata?.generationState === 'streaming'
      ) {
        return message.id
      }
    }

    return null
  }, [chatMessages])
  const quickAskTimelineItems = useMemo(
    () =>
      buildMessageTimelineItems({
        groupedChatMessages,
        revisionsById: chatTimelineReadModel.revisionsById,
        activeEditableMessageId: focusedUserMessageId,
        activeStreamingMessageId,
        includeBottomAnchor: true,
      }),
    [
      activeStreamingMessageId,
      chatTimelineReadModel.revisionsById,
      focusedUserMessageId,
      groupedChatMessages,
    ],
  )
  const stableQuickAskTimelineItems = useStableChatTimelineItems(
    quickAskTimelineItems,
  )
  const hideScrollbarWhileFollowing =
    isStreaming && isAutoFollowEnabled && hasMessages
  const quickAskChatShellClassName = 'yolo-quick-ask-chat-shell'
  const quickAskChatAreaClassName = useMemo(
    () =>
      `yolo-chat-messages yolo-quick-ask-chat-area yolo-quick-ask-chat-area--shared${hideScrollbarWhileFollowing ? ' yolo-quick-ask-chat-area--hide-scrollbar' : ''}`,
    [hideScrollbarWhileFollowing],
  )
  const latestTimelineAssistantToolGroupKey = useMemo(() => {
    for (
      let index = stableQuickAskTimelineItems.length - 1;
      index >= 0;
      index -= 1
    ) {
      const candidate = stableQuickAskTimelineItems[index]
      if (candidate.kind === 'assistant-group') {
        return candidate.renderKey
      }
    }

    return null
  }, [stableQuickAskTimelineItems])
  // Global key handling to match palette UX (Esc closes, even when dropdown is open)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (isAssistantMenuOpen) {
        event.preventDefault()
        setMenuOpen('assistant', false)
        return
      }
      if (isModelMenuOpen || isReasoningMenuOpen || isModeMenuOpen) {
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
    isReasoningMenuOpen,
    isModeMenuOpen,
    isStreaming,
    onClose,
    setMenuOpen,
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
    document.body.classList.add('yolo-quick-ask-global-interaction')
    document.body.setCssProps({
      '--yolo-quick-ask-global-cursor': 'grabbing',
      '--yolo-quick-ask-global-user-select': 'none',
    })

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('yolo-quick-ask-global-interaction')
      document.body.setCssProps({
        '--yolo-quick-ask-global-cursor': '',
        '--yolo-quick-ask-global-user-select': '',
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
    document.body.classList.add('yolo-quick-ask-global-interaction')
    document.body.setCssProps({
      '--yolo-quick-ask-global-cursor': cursor,
      '--yolo-quick-ask-global-user-select': 'none',
    })

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('yolo-quick-ask-global-interaction')
      document.body.setCssProps({
        '--yolo-quick-ask-global-cursor': '',
        '--yolo-quick-ask-global-user-select': '',
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

  const renderQuickAskTimelineItem = useCallback(
    (timelineItem: ChatTimelineItem) => {
      if (timelineItem.kind === 'assistant-group') {
        const messages = timelineItem.messageIds
          .map((messageId) => chatTimelineReadModel.messagesById.get(messageId))
          .filter(
            (message): message is AssistantToolMessageGroup[number] =>
              message !== undefined && message.role !== 'user',
          )
        if (messages.length === 0) {
          return null
        }

        return (
          <AssistantToolMessageGroupItem
            messages={messages}
            conversationId={conversationId}
            suppressFooter={
              isStreaming &&
              timelineItem.renderKey === latestTimelineAssistantToolGroupKey
            }
            showInlineInfo={
              quickAskSurfacePreset.assistantActions.showInlineInfo
            }
            showRetryAction={
              quickAskSurfacePreset.assistantActions.showRetryAction
            }
            showInsertAction={
              quickAskSurfacePreset.assistantActions.showInsertAction
            }
            showCopyAction={
              quickAskSurfacePreset.assistantActions.showCopyAction
            }
            showBranchAction={
              quickAskSurfacePreset.assistantActions.showBranchAction
            }
            showEditAction={
              quickAskSurfacePreset.assistantActions.showEditAction
            }
            showDeleteAction={
              quickAskSurfacePreset.assistantActions.showDeleteAction
            }
            isApplying={isApplying}
            activeApplyRequestKey={activeApplyRequestKey}
            onApply={handleApply}
            onToolMessageUpdate={handleToolMessageUpdate}
            onToolCallResponseUpdate={handleToolCallResponseUpdate}
            onEditStart={noop}
            onEditCancel={noop}
            onEditSave={noop}
            onDeleteGroup={handleDeleteGroup}
            onRetryGroup={noop}
            onBranchGroup={noop}
            onQuoteAssistantSelection={noop}
            onOpenEditSummaryFile={handleOpenEditSummaryFile}
            showQuoteAction={
              quickAskSurfacePreset.assistantActions.showQuoteAction
            }
            showRunningToolFooter={false}
          />
        )
      }

      if (timelineItem.kind === 'user-message') {
        const messageOrGroup = chatTimelineReadModel.messagesById.get(
          timelineItem.messageId,
        )
        if (!messageOrGroup || messageOrGroup.role !== 'user') {
          return null
        }
        const groupedMessageIndex = groupedChatMessages.findIndex(
          (candidate) =>
            !Array.isArray(candidate) && candidate.id === messageOrGroup.id,
        )

        return (
          <div
            data-user-message-id={messageOrGroup.id}
            className={`yolo-quick-ask-user-message${focusedUserMessageId === messageOrGroup.id ? ' yolo-quick-ask-user-message--editing' : ''}`}
          >
            <UserMessageItem
              message={messageOrGroup}
              isFocused={focusedUserMessageId === messageOrGroup.id}
              displayMentionables={messageOrGroup.mentionables}
              chatUserInputRef={(ref) =>
                registerChatUserInputRef(messageOrGroup.id, ref)
              }
              onControlPopoverOpenChange={(isOpen) => {
                if (!isOpen) {
                  return
                }
                suppressNextFocusedUserMessageOutsidePointerRef.current =
                  messageOrGroup.id
              }}
              onInputChange={(content) => {
                setChatMessages((prev) =>
                  prev.map((message) =>
                    message.role === 'user' && message.id === messageOrGroup.id
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
                  messageOrGroup.mentionables.length === 0 &&
                  (messageOrGroup.selectedSkills?.length ?? 0) === 0
                ) {
                  return
                }

                const baseMessages = groupedChatMessages
                  .slice(0, groupedMessageIndex)
                  .flatMap((group): ChatMessage[] =>
                    Array.isArray(group) ? group : [group],
                  )

                void submitMessage(content, messageOrGroup.mentionables, {
                  baseMessages,
                  userMessageId: messageOrGroup.id,
                  selectedSkillsOverride: messageOrGroup.selectedSkills ?? [],
                })
                setFocusedUserMessageId(null)
                requestAnimationFrame(() => {
                  messageInputRef.current?.focus()
                })
              }}
              onFocus={() => {
                setFocusedUserMessageId(messageOrGroup.id)
              }}
              onMentionablesChange={(mentionables) => {
                setChatMessages((prev) =>
                  prev.map((message) =>
                    message.role === 'user' && message.id === messageOrGroup.id
                      ? {
                          ...message,
                          mentionables,
                          promptContent: null,
                        }
                      : message,
                  ),
                )
              }}
              onSelectedSkillsChange={(skills) => {
                setChatMessages((prev) =>
                  prev.map((message) =>
                    message.role === 'user' && message.id === messageOrGroup.id
                      ? {
                          ...message,
                          selectedSkills: skills,
                          promptContent: null,
                        }
                      : message,
                  ),
                )
              }}
              modelId={
                settings.continuationOptions?.continuationModelId &&
                settings.chatModels.some(
                  (model) =>
                    model.id ===
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
              showReasoningSelect={
                quickAskSurfacePreset.userMessage.showReasoningSelect
              }
              showPlaceholder={false}
              currentAssistantId={selectedAssistant?.id}
              currentChatMode={mode === 'continue' ? undefined : mode}
              allowAgentModeOption={
                quickAskSurfacePreset.userMessage.allowAgentModeOption
              }
            />
          </div>
        )
      }

      if (timelineItem.kind === 'bottom-anchor') {
        return <div className="yolo-chat-bottom-anchor" aria-hidden="true" />
      }

      return null
    },
    [
      activeApplyRequestKey,
      chatTimelineReadModel.messagesById,
      conversationId,
      focusedUserMessageId,
      groupedChatMessages,
      handleApply,
      handleDeleteGroup,
      handleOpenEditSummaryFile,
      handleToolMessageUpdate,
      isStreaming,
      isApplying,
      latestTimelineAssistantToolGroupKey,
      quickAskChatAreaClassName,
      quickAskSurfacePreset,
      registerChatUserInputRef,
      selectedAssistant?.id,
      setSettings,
      settings,
      submitMessage,
      mode,
    ],
  )

  const quickAskTimelineRenderVersion = useCallback(
    (timelineItem: ChatTimelineItem): string => {
      if (timelineItem.kind === 'assistant-group') {
        return [
          'assistant',
          timelineItem.revision,
          conversationId,
          isStreaming &&
            timelineItem.renderKey === latestTimelineAssistantToolGroupKey,
          quickAskSurfacePreset.assistantActions.showInlineInfo,
          quickAskSurfacePreset.assistantActions.showRetryAction,
          quickAskSurfacePreset.assistantActions.showInsertAction,
          quickAskSurfacePreset.assistantActions.showCopyAction,
          quickAskSurfacePreset.assistantActions.showBranchAction,
          quickAskSurfacePreset.assistantActions.showEditAction,
          quickAskSurfacePreset.assistantActions.showDeleteAction,
          quickAskSurfacePreset.assistantActions.showQuoteAction,
          isApplying,
          activeApplyRequestKey ?? '',
        ].join('|')
      }

      if (timelineItem.kind === 'user-message') {
        return [
          'user',
          timelineItem.revision,
          focusedUserMessageId === timelineItem.messageId,
          settings.continuationOptions?.continuationModelId ?? '',
          settings.chatModelId,
          getQuickAskRenderVersionObjectId(settings.chatModels),
          selectedAssistant?.id ?? '',
          mode,
          quickAskSurfacePreset.userMessage.showReasoningSelect,
          quickAskSurfacePreset.userMessage.allowAgentModeOption,
        ].join('|')
      }

      return timelineItem.renderKey
    },
    [
      activeApplyRequestKey,
      conversationId,
      focusedUserMessageId,
      isApplying,
      isStreaming,
      latestTimelineAssistantToolGroupKey,
      mode,
      quickAskSurfacePreset,
      selectedAssistant?.id,
      settings,
    ],
  )

  return (
    // 流式正文不再随会话快照到达：正文/思考走展示流，跟随由播放器在可见帧
    // commit 后直接触发。
    <AssistantRenderStreamProvider access={plugin.getAgentService()}>
      <LiveEdgeFollowProvider onFollowLiveEdge={autoScrollToBottom}>
        <div
          className={`yolo-quick-ask-panel ${hasMessages ? 'has-messages' : ''} ${isResizedEmptyState ? 'is-resized-empty' : ''} ${isDragging ? 'is-dragging' : ''} ${isResizing ? 'is-resizing' : ''}`}
          ref={containerRef ?? undefined}
          onKeyDown={handlePanelKeyDown}
          style={
            panelSize
              ? {
                  width: panelSize.width,
                  maxWidth: panelSize.width,
                  ...(panelSize.height
                    ? {
                        height: panelSize.height,
                        maxHeight: panelSize.height,
                      }
                    : {}),
                }
              : undefined
          }
        >
          <div className="yolo-quick-ask-header-actions">
            <button
              type="button"
              className="yolo-quick-ask-header-button"
              onClick={onClose}
              aria-label={t('quickAsk.close', 'Close')}
            >
              <X size={14} />
            </button>
          </div>

          <div
            ref={dragHandleRef}
            className="yolo-quick-ask-drag-handle"
            onMouseDown={handleDragStart}
          >
            <div className="yolo-quick-ask-drag-indicator" />
          </div>

          {/* Chat area - only shown when there are messages */}
          {hasMessages && (
            <SharedConversationSurface
              items={stableQuickAskTimelineItems}
              conversationId={conversationId}
              scrollContainerRef={chatAreaRef}
              onScrollContainerChange={setChatAreaElement}
              onBottomSentinelChange={setChatBottomSentinelElement}
              containerClassName={quickAskChatShellClassName}
              renderItem={renderQuickAskTimelineItem}
              renderVersion={quickAskTimelineRenderVersion}
              forceRenderItemIds={['bottom-anchor']}
              virtualizationThreshold={
                focusedUserMessageId
                  ? stableQuickAskTimelineItems.length
                  : undefined
              }
              scrollContainerClassName={quickAskChatAreaClassName}
            />
          )}

          {/* Composer: input + toolbar stay glued together in both empty and chat layouts.
          The continue-mode preset menu anchors to the composer so it floats below
          the panel as a detached Quick-Ask-style popover. */}
          <Popover.Root open={showContinueActionsMenu}>
            <Popover.Anchor asChild>
              <div className="yolo-quick-ask-composer">
                {/* Keep mounted during streaming (disabled keep-alive) */}
                <div className="yolo-quick-ask-input-row" ref={inputRowRef}>
                  <div
                    className={`yolo-quick-ask-input ${isStreaming ? 'is-disabled' : ''}`}
                  >
                    <MessageInputCore
                      ref={messageInputRef}
                      initialSerializedEditorState={
                        initialSerializedEditorState
                      }
                      onChange={handleMainInputChange}
                      onTextContentChange={setInputText}
                      onEnter={handleEnter}
                      autoFocus
                      disabled={isStreaming}
                      enableSkills
                      enableAttachments={false}
                      mentionables={mentionables}
                      setMentionables={setMentionables}
                      selectedSkills={selectedSkills}
                      setSelectedSkills={setSelectedSkills}
                      mentionDisplayMode="inline"
                      contentClassName="yolo-obsidian-textarea yolo-content-editable yolo-quick-ask-content-editable"
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowDown') {
                          event.preventDefault()
                          modeTriggerRef.current?.focus()
                        }
                      }}
                      onMentionMenuToggle={(open) => {
                        setMenuOpen('mention', open)
                        if (open) updateMentionMenuPlacement()
                      }}
                      mentionMenuPlacement={mentionMenuPlacement}
                      models={enabledChatModels}
                      skills={availableSkills}
                    />
                    {inputText.length === 0 &&
                      mentionables.length === 0 &&
                      selectedSkills.length === 0 &&
                      !isStreaming && (
                        <div className="yolo-quick-ask-input-placeholder">
                          {isContinueMode
                            ? t(
                                'quickAsk.continuePlaceholder',
                                'Leave empty to continue writing, or add instructions...',
                              )
                            : t(
                                'quickAsk.inputPlaceholder',
                                'Ask a question...',
                              )}
                        </div>
                      )}
                  </div>
                </div>

                {/* Toolbar: mode / model / assistant left, send right */}
                <div className="yolo-quick-ask-toolbar">
                  {/* Left: mode / model / assistant selectors */}
                  <div className="yolo-quick-ask-toolbar-left">
                    <DropdownMenu.Root
                      open={isAssistantMenuOpen}
                      onOpenChange={(open) => setMenuOpen('assistant', open)}
                    >
                      <DropdownMenu.Trigger asChild>
                        <button
                          type="button"
                          ref={assistantTriggerRef}
                          className="yolo-quick-ask-assistant-trigger"
                          onKeyDown={(event) => {
                            if (!isAssistantMenuOpen) {
                              if (event.key === 'ArrowUp') {
                                event.preventDefault()
                                event.stopPropagation()
                                messageInputRef.current?.focus()
                                return
                              }
                              if (event.key === 'ArrowLeft') {
                                event.preventDefault()
                                event.stopPropagation()
                                reasoningTriggerRef.current?.focus()
                                return
                              }
                              if (event.key === 'ArrowRight') {
                                event.preventDefault()
                                event.stopPropagation()
                                modeTriggerRef.current?.focus()
                                return
                              }
                            }
                          }}
                        >
                          {selectedAssistant && (
                            <span className="yolo-quick-ask-assistant-icon">
                              {renderAssistantIcon(selectedAssistant.icon, 14)}
                            </span>
                          )}
                          <span className="yolo-quick-ask-assistant-name">
                            {selectedAssistant?.name ||
                              t('quickAsk.noAssistant', 'No Assistant')}
                          </span>
                          {isAssistantMenuOpen ? (
                            <ChevronUp size={12} />
                          ) : (
                            <ChevronDown size={12} />
                          )}
                        </button>
                      </DropdownMenu.Trigger>
                      <YoloDropdownContent
                        anchorRef={assistantTriggerRef}
                        container={popoverPortalHost ?? undefined}
                        variant="default"
                        minWidth={200}
                        maxWidth={300}
                        side="bottom"
                        align="center"
                        sideOffset={12}
                        collisionPadding={8}
                        onCloseAutoFocus={(e) => e.preventDefault()}
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
                            setMenuOpen('assistant', false)
                            requestAnimationFrame(() => {
                              messageInputRef.current?.focus()
                            })
                          }}
                          onClose={() => setMenuOpen('assistant', false)}
                          compact
                        />
                      </YoloDropdownContent>
                    </DropdownMenu.Root>

                    <div className="yolo-quick-ask-model-select yolo-continuation-model-select">
                      <ModelSelect
                        ref={modelTriggerRef}
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
                        container={popoverPortalHost ?? undefined}
                        onMenuOpenChange={(open) => setMenuOpen('model', open)}
                        onChange={(modelId) => {
                          // reasoningLevel is re-derived by the model-change
                          // effect above (remembered level for the new model,
                          // falling back to its default) — no need to set it here.
                          void setSettings({
                            ...settings,
                            continuationOptions: {
                              ...settings.continuationOptions,
                              continuationModelId: modelId,
                            },
                          })
                        }}
                        side="bottom"
                        align="center"
                        sideOffset={12}
                        alignOffset={0}
                        popover={{
                          variant: 'default',
                          maxHeight: 400,
                          className: 'yolo-quick-ask-model-popover',
                        }}
                        onKeyDown={(event, isMenuOpen) => {
                          if (isMenuOpen) {
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              setMenuOpen('model', false)
                            }
                            return
                          }

                          if (event.key === 'ArrowLeft') {
                            event.preventDefault()
                            modeTriggerRef.current?.focus()
                            return
                          }
                          if (event.key === 'ArrowRight') {
                            event.preventDefault()
                            reasoningTriggerRef.current?.focus()
                            return
                          }
                          if (event.key === 'ArrowUp') {
                            event.preventDefault()
                            messageInputRef.current?.focus()
                          }
                        }}
                        onModelSelected={() => {
                          requestAnimationFrame(() => {
                            modelTriggerRef.current?.focus({
                              preventScroll: true,
                            })
                          })
                        }}
                      />
                    </div>

                    <div
                      className="yolo-quick-ask-reasoning-select"
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowLeft') {
                          event.preventDefault()
                          event.stopPropagation()
                          modelTriggerRef.current?.focus()
                        } else if (event.key === 'ArrowRight') {
                          event.preventDefault()
                          event.stopPropagation()
                          assistantTriggerRef.current?.focus()
                        } else if (event.key === 'ArrowUp') {
                          event.preventDefault()
                          event.stopPropagation()
                          messageInputRef.current?.focus()
                        }
                      }}
                    >
                      {supportsReasoning(model ?? null) && (
                        <ReasoningSelect
                          ref={reasoningTriggerRef}
                          model={model ?? null}
                          value={reasoningLevel}
                          onChange={handleReasoningLevelChange}
                          onMenuOpenChange={(open) =>
                            setMenuOpen('reasoning', open)
                          }
                          container={popoverPortalHost ?? undefined}
                          side="bottom"
                          align="center"
                          sideOffset={12}
                        />
                      )}
                    </div>

                    <div className="yolo-quick-ask-mode-select">
                      <ChatModeSelect
                        ref={modeTriggerRef}
                        mode={mode}
                        availableModes={
                          capabilities.edit
                            ? ['ask', 'agent', 'continue']
                            : ['ask', 'agent']
                        }
                        yoloEnabled={yoloEnabled}
                        onYoloChange={handleYoloChange}
                        triggerLabel={modeTriggerLabel}
                        popoverClassName="yolo-quick-ask-mode-popover"
                        onArrowDownWhenClosed={() =>
                          isContinueMode && showContinueActionsMenu
                            ? focusFirstContinueAction()
                            : false
                        }
                        onChange={(nextMode) => {
                          if (
                            nextMode === 'ask' ||
                            nextMode === 'agent' ||
                            nextMode === 'continue'
                          ) {
                            handleModeChange(nextMode)
                          }
                        }}
                        onMenuOpenChange={(open) => setMenuOpen('mode', open)}
                        container={popoverPortalHost ?? undefined}
                        side="bottom"
                        align="start"
                        sideOffset={12}
                        alignOffset={-4}
                        onKeyDown={(event, isMenuOpen) => {
                          if (isMenuOpen) {
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              setMenuOpen('mode', false)
                            }
                            return
                          }

                          if (event.key === 'ArrowLeft') {
                            event.preventDefault()
                            messageInputRef.current?.focus()
                            return
                          }
                          if (event.key === 'ArrowRight') {
                            event.preventDefault()
                            modelTriggerRef.current?.focus()
                            return
                          }
                          if (event.key === 'ArrowUp') {
                            event.preventDefault()
                            messageInputRef.current?.focus()
                          }
                        }}
                      />
                    </div>
                  </div>

                  {/* Right: Send / stop */}
                  <div className="yolo-quick-ask-toolbar-right">
                    <SubmitButton
                      isGenerating={isStreaming}
                      onAbort={abortStream}
                      disabled={
                        isStreaming ||
                        (isRewriteIntent
                          ? inputText.trim().length === 0
                          : mode === 'continue'
                            ? false
                            : !canSubmitMainInput)
                      }
                      onClick={handleEnter}
                    />
                  </div>
                </div>
              </div>
            </Popover.Anchor>

            <YoloPopoverContent
              variant="continuation"
              className="yolo-quick-ask-continue-menu"
              anchorRef={inputRowRef}
              container={popoverPortalHost ?? undefined}
              side="bottom"
              align="start"
              sideOffset={4}
              minWidth={200}
              maxWidth={320}
              maxHeight={300}
              collisionPadding={8}
              onOpenAutoFocus={(event) => event.preventDefault()}
              onKeyDown={handleContinueMenuKeyDown}
            >
              {continueQuickActions.map((action) => {
                const ActionIcon =
                  ICON_OPTIONS[action.icon as keyof typeof ICON_OPTIONS]
                    ?.component ?? Sparkles
                return (
                  <button
                    key={action.id}
                    type="button"
                    className="yolo-quick-ask-continue-menu-item"
                    onClick={() => submitContinue(action.instruction)}
                  >
                    <span className="yolo-quick-ask-continue-menu-item__icon">
                      <ActionIcon size={13} />
                    </span>
                    <span className="yolo-quick-ask-continue-menu-item__label">
                      {action.label}
                    </span>
                  </button>
                )
              })}
            </YoloPopoverContent>
          </Popover.Root>

          {/* Resize handles */}
          <div
            className="yolo-quick-ask-resize-handle yolo-quick-ask-resize-handle-right"
            onMouseDown={handleResizeStart('right')}
            ref={(el) => (resizeHandlesRef.current.right = el)}
          />
          <div
            className="yolo-quick-ask-resize-handle yolo-quick-ask-resize-handle-bottom"
            onMouseDown={handleResizeStart('bottom')}
            ref={(el) => (resizeHandlesRef.current.bottom = el)}
          />
          <div
            className="yolo-quick-ask-resize-handle yolo-quick-ask-resize-handle-bottom-left"
            onMouseDown={handleResizeStart('bottom-left')}
            ref={(el) => (resizeHandlesRef.current.bottomLeft = el)}
          />
          <div
            className="yolo-quick-ask-resize-handle yolo-quick-ask-resize-handle-bottom-right"
            onMouseDown={handleResizeStart('bottom-right')}
            ref={(el) => (resizeHandlesRef.current.bottomRight = el)}
          />
        </div>
      </LiveEdgeFollowProvider>
    </AssistantRenderStreamProvider>
  )
}
