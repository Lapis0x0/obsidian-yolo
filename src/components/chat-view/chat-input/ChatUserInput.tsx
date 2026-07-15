import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { SerializedEditorState } from 'lexical'
import { FilePlus2 } from 'lucide-react'
import { Notice } from 'obsidian'
import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useApp } from '../../../contexts/app-context'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { getYoloSnippetsPath } from '../../../core/paths/yoloPaths'
import { isSkillEnabledForAssistant } from '../../../core/skills/skillPolicy'
import { openSnippetsFileInVault } from '../../../core/snippets/snippetsFile'
import { useLiteSkillEntries } from '../../../hooks/useLiteSkillEntries'
import { ChatSelectedSkill } from '../../../types/chat'
import { ChatModel } from '../../../types/chat-model.types'
import { Mentionable } from '../../../types/mentionable'
import {
  ReasoningLevel,
  getDefaultReasoningLevel,
} from '../../../types/reasoning'
import {
  getMentionableKey,
  serializeMentionable,
} from '../../../utils/chat/mentionable'
import ContextUsagePopover from '../ContextUsagePopover'
import ContextUsageRing from '../ContextUsageRing'
import { useSnippetEntries } from '../hooks/useSnippetEntries'
import type { ContextBreakdownInputs } from '../useContextBreakdown'

import {
  type ChatInputEditorSeed,
  isChatInputEmpty,
  resolveChatInputEditorSeed,
} from './chatInputDraft'
import { ChatMode, ChatModeSelect } from './ChatModeSelect'
import { ChatQuickAccess } from './ChatQuickAccess'
import ChatSkillBadge from './ChatSkillBadge'
import { FileUploadButton } from './FileUploadButton'
import MentionableBadge from './MentionableBadge'
import MessageInputCore, { type MessageInputCoreRef } from './MessageInputCore'
import { ModelSelect } from './ModelSelect'
import type { SlashCommand } from './plugins/mention/SkillSlashPlugin'
import { ReasoningSelect, supportsReasoning } from './ReasoningSelect'
import { SubmitButton } from './SubmitButton'
import { editorStateToPlainText } from './utils/editor-state-to-plain-text'

export type ChatUserInputRef = {
  focus: () => void
  insertText: (text: string) => void
  appendText: (text: string) => void
  replaceText: (text: string) => void
  submit: () => void
}

export type ChatUserInputControlLayout = 'composer-toolbar' | 'inline'

export type ChatUserInputProps = {
  initialSerializedEditorState: SerializedEditorState | null
  getInitialSerializedEditorState?: () => SerializedEditorState | null
  replacementVersion?: number
  onChange: (content: SerializedEditorState) => void
  onSubmit: (content: SerializedEditorState) => void
  onFocus: () => void
  mentionables: Mentionable[]
  setMentionables: (mentionables: Mentionable[]) => void
  selectedSkills?: ChatSelectedSkill[]
  setSelectedSkills?: (skills: ChatSelectedSkill[]) => void
  autoFocus?: boolean
  addedBlockKey?: string | null
  modelId?: string
  onModelChange?: (modelId: string) => void
  // 用于显示聚合后的 mentionables(包含历史消息中的文件)
  displayMentionables?: Mentionable[]
  // 删除时从所有消息中删除的回调
  onDeleteFromAll?: (mentionable: Mentionable) => void
  // Reasoning level
  reasoningLevel?: ReasoningLevel
  onReasoningChange?: (level: ReasoningLevel) => void
  showReasoningSelect?: boolean
  showPlaceholder?: boolean
  // Compact mode: hide controls for historical messages
  compact?: boolean
  hideBadgeMentionables?: boolean
  onToggleCompact?: () => void
  currentAssistantId?: string
  onSelectAssistantForConversation?: (assistantId: string) => void
  currentChatMode?: ChatMode
  onSelectChatModeForConversation?: (mode: ChatMode) => void
  chatMode?: ChatMode
  onChatModeChange?: (mode: ChatMode) => void
  yoloEnabled?: boolean
  onYoloChange?: (enabled: boolean) => void
  controlLayout?: ChatUserInputControlLayout
  onControlPopoverOpenChange?: (isOpen: boolean) => void
  allowAgentModeOption?: boolean
  enableResize?: boolean
  onRunSlashCommand?: (command: SlashCommand) => void
  // 当父级正在执行 conversation run 时，发送按钮切换为停止按钮（圆形 + 方块）
  isGenerating?: boolean
  canQueueWhileGenerating?: boolean
  onAbort?: () => void
  // 上下文窗口占用环，传入时显示在发送按钮左侧
  contextUsage?: {
    promptTokens: number
    maxContextTokens: number | null
    label: string
    /** When provided, the ring becomes a popover trigger that opens the
     * per-bucket context breakdown. Builder is called lazily on open and may
     * be async; resolution to null surfaces as a non-blocking error inside
     * the popover (the ring still works for hover hint). */
    buildBreakdownInputs?: () =>
      | ContextBreakdownInputs
      | null
      | Promise<ContextBreakdownInputs | null>
  }
  showQuickAccess?: boolean
}

const DEFAULT_INPUT_HEIGHT = 80
const MIN_INPUT_HEIGHT = 80
const MAX_INPUT_HEIGHT = 520

function isFileDragEvent(event: ReactDragEvent<HTMLDivElement>) {
  const types = Array.from(event.dataTransfer.types ?? [])
  return types.includes('Files')
}

const ChatUserInput = forwardRef<ChatUserInputRef, ChatUserInputProps>(
  (
    {
      initialSerializedEditorState,
      getInitialSerializedEditorState,
      replacementVersion = 0,
      onChange,
      onSubmit,
      onFocus,
      mentionables,
      setMentionables,
      selectedSkills = [],
      setSelectedSkills,
      autoFocus = false,
      modelId,
      onModelChange,
      displayMentionables,
      onDeleteFromAll,
      reasoningLevel,
      onReasoningChange,
      showReasoningSelect = true,
      showPlaceholder = true,
      compact = false,
      hideBadgeMentionables = false,
      onToggleCompact,
      currentAssistantId,
      onSelectAssistantForConversation,
      currentChatMode,
      onSelectChatModeForConversation,
      chatMode,
      onChatModeChange,
      yoloEnabled = false,
      onYoloChange,
      controlLayout = 'composer-toolbar',
      onControlPopoverOpenChange,
      allowAgentModeOption = true,
      enableResize = false,
      onRunSlashCommand,
      isGenerating = false,
      canQueueWhileGenerating = true,
      onAbort,
      contextUsage,
      showQuickAccess = false,
    },
    ref,
  ) => {
    const app = useApp()
    const { t } = useLanguage()
    const { settings, setSettings } = useSettings()
    const reduceMotion = useReducedMotion()
    const mentionDisplayMode =
      settings.chatOptions.mentionDisplayMode ?? 'inline'
    const rememberedInputHeight = useMemo(() => {
      const chatInputHeight = settings.chatOptions.chatInputHeight
      if (typeof chatInputHeight !== 'number') {
        return null
      }
      return Math.max(
        MIN_INPUT_HEIGHT,
        Math.min(MAX_INPUT_HEIGHT, chatInputHeight),
      )
    }, [settings.chatOptions.chatInputHeight])

    const currentModel: ChatModel | null = useMemo(() => {
      if (!modelId) return null
      return settings.chatModels.find((m) => m.id === modelId) ?? null
    }, [modelId, settings.chatModels])

    const coreRef = useRef<MessageInputCoreRef>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const editorSeedRef = useRef<ChatInputEditorSeed | null>(null)
    const editorSeed = resolveChatInputEditorSeed(
      editorSeedRef.current,
      replacementVersion,
      () =>
        getInitialSerializedEditorState
          ? getInitialSerializedEditorState()
          : initialSerializedEditorState,
    )
    editorSeedRef.current = editorSeed
    const latestContentRef = useRef<SerializedEditorState | null>(
      editorSeed.content,
    )
    const [isTextEmpty, setIsTextEmpty] = useState(() =>
      editorSeed.content
        ? editorStateToPlainText(editorSeed.content).trim().length === 0
        : true,
    )
    const [resizedHeight, setResizedHeight] = useState<number | null>(
      rememberedInputHeight,
    )
    const resizedHeightRef = useRef<number | null>(rememberedInputHeight)
    const dragStartYRef = useRef(0)
    const dragStartHeightRef = useRef(DEFAULT_INPUT_HEIGHT)
    const fileDragDepthRef = useRef(0)
    const [isFileDragActive, setIsFileDragActive] = useState(false)

    const effectiveMentionables = useMemo(
      () => displayMentionables ?? mentionables,
      [displayMentionables, mentionables],
    )
    const effectiveSelectedSkills = useMemo(
      () => selectedSkills,
      [selectedSkills],
    )
    const selectedSkillsRef = useRef(effectiveSelectedSkills)
    selectedSkillsRef.current = effectiveSelectedSkills
    const enabledChatModels = useMemo(
      () => settings.chatModels.filter((model) => model.enable ?? true),
      [settings.chatModels],
    )

    const allSkillEntries = useLiteSkillEntries(app, { settings })
    const availableAssistants = useMemo(
      () => settings.assistants || [],
      [settings.assistants],
    )
    const availableSkills = useMemo(() => {
      const currentAssistant = currentAssistantId
        ? (availableAssistants.find(
            (assistant) => assistant.id === currentAssistantId,
          ) ?? null)
        : null

      if (!currentAssistant) {
        return []
      }

      const disabledSkillNames = settings.skills?.disabledSkillIds ?? []
      return allSkillEntries.filter((skill) =>
        isSkillEnabledForAssistant({
          assistant: currentAssistant,
          skillName: skill.name,
          disabledSkillNames,
          defaultLoadMode: skill.mode,
        }),
      )
    }, [allSkillEntries, availableAssistants, currentAssistantId, settings])

    const availableSnippets = useSnippetEntries()

    const handleCreateSnippetsFile = useCallback(() => {
      void (async () => {
        const snippetsPath = getYoloSnippetsPath(settings)
        try {
          await openSnippetsFileInVault(app, settings)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          new Notice(`Failed to open ${snippetsPath}: ${message}`)
        }
      })()
    }, [app, settings])

    const resolvedReasoningLevel = useMemo(() => {
      if (reasoningLevel) return reasoningLevel
      return getDefaultReasoningLevel(currentModel)
    }, [currentModel, reasoningLevel])

    useEffect(() => {
      latestContentRef.current = editorSeed.content
      const nextIsEmpty = editorSeed.content
        ? editorStateToPlainText(editorSeed.content).trim().length === 0
        : true
      setIsTextEmpty((current) =>
        current === nextIsEmpty ? current : nextIsEmpty,
      )
    }, [editorSeed])

    useEffect(() => {
      if (!compact) {
        return
      }

      const activeElement = (containerRef.current?.ownerDocument ?? document)
        .activeElement
      if (
        activeElement instanceof HTMLElement &&
        containerRef.current?.contains(activeElement)
      ) {
        activeElement.blur()
      }
    }, [compact])

    useEffect(() => {
      setResizedHeight(rememberedInputHeight)
    }, [rememberedInputHeight])

    useEffect(() => {
      resizedHeightRef.current = resizedHeight
    }, [resizedHeight])

    useEffect(() => {
      return () => {
        ;(containerRef.current?.ownerDocument ?? document).body.setCssProps({
          '--yolo-chat-input-resize-cursor': '',
          '--yolo-chat-input-resize-user-select': '',
        })
      }
    }, [])

    const handleChange = useCallback(
      (content: SerializedEditorState) => {
        latestContentRef.current = content
        onChange(content)
      },
      [onChange],
    )

    const handleTextContentChange = useCallback((text: string) => {
      const nextIsEmpty = text.trim().length === 0
      setIsTextEmpty((current) =>
        current === nextIsEmpty ? current : nextIsEmpty,
      )
    }, [])

    const submitDisabled = isChatInputEmpty(
      isTextEmpty ? '' : 'content',
      mentionables.length,
      selectedSkills.length,
    )

    const handleEnter = useCallback(() => {
      const content = latestContentRef.current
      if (content) {
        onSubmit(content)
      }
    }, [onSubmit])

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          coreRef.current?.focus()
        },
        insertText: (text: string) => {
          coreRef.current?.insertText(text)
        },
        appendText: (text: string) => {
          coreRef.current?.appendText(text)
        },
        replaceText: (text: string) => {
          coreRef.current?.replaceText(text)
        },
        submit: () => {
          coreRef.current?.submit()
        },
      }),
      [],
    )

    const handleDeleteMentionableFromBadge = useCallback(
      (mentionable: Mentionable) => {
        if (onDeleteFromAll) {
          onDeleteFromAll(mentionable)
          return
        }
        const mentionableKey = getMentionableKey(
          serializeMentionable(mentionable),
        )
        setMentionables(
          mentionables.filter(
            (item) =>
              getMentionableKey(serializeMentionable(item)) !== mentionableKey,
          ),
        )
      },
      [mentionables, onDeleteFromAll, setMentionables],
    )

    const handleDeleteSelectedSkill = useCallback(
      (skillName: string) => {
        if (!setSelectedSkills) {
          return
        }
        setSelectedSkills(
          effectiveSelectedSkills.filter((skill) => skill.name !== skillName),
        )
      },
      [effectiveSelectedSkills, setSelectedSkills],
    )

    const handleTriggerClick = useCallback((char: string) => {
      coreRef.current?.insertText(char)
    }, [])

    const clearResizeBodyStyles = useCallback(() => {
      ;(containerRef.current?.ownerDocument ?? document).body.setCssProps({
        '--yolo-chat-input-resize-cursor': '',
        '--yolo-chat-input-resize-user-select': '',
      })
    }, [])

    const persistResizedHeight = useCallback(
      async (height: number | null) => {
        const nextStoredHeight =
          height === null
            ? undefined
            : Math.max(
                MIN_INPUT_HEIGHT,
                Math.min(MAX_INPUT_HEIGHT, Math.round(height)),
              )

        if (settings.chatOptions.chatInputHeight === nextStoredHeight) {
          return
        }

        await setSettings({
          ...settings,
          chatOptions: {
            ...settings.chatOptions,
            chatInputHeight: nextStoredHeight,
          },
        })
      },
      [setSettings, settings],
    )

    const startResize = useCallback(
      (clientY: number) => {
        dragStartYRef.current = clientY
        dragStartHeightRef.current =
          resizedHeight ??
          containerRef.current?.querySelector<HTMLElement>(
            '.yolo-content-editable',
          )?.offsetHeight ??
          DEFAULT_INPUT_HEIGHT

        const ownerDoc = containerRef.current?.ownerDocument ?? document
        const ownerWin = ownerDoc.defaultView ?? window
        ownerDoc.body.setCssProps({
          '--yolo-chat-input-resize-cursor': 'ns-resize',
          '--yolo-chat-input-resize-user-select': 'none',
        })

        const handleMouseMove = (moveEvent: MouseEvent) => {
          const deltaY = dragStartYRef.current - moveEvent.clientY
          const nextHeight = Math.max(
            MIN_INPUT_HEIGHT,
            Math.min(MAX_INPUT_HEIGHT, dragStartHeightRef.current + deltaY),
          )
          setResizedHeight(nextHeight)
        }

        const handleMouseUp = () => {
          ownerWin.removeEventListener('mousemove', handleMouseMove)
          ownerWin.removeEventListener('mouseup', handleMouseUp)
          clearResizeBodyStyles()
          void persistResizedHeight(resizedHeightRef.current)
        }

        ownerWin.addEventListener('mousemove', handleMouseMove)
        ownerWin.addEventListener('mouseup', handleMouseUp)
      },
      [clearResizeBodyStyles, persistResizedHeight, resizedHeight],
    )

    const handleResizeHitboxMouseDown = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        if (!enableResize || compact) {
          return
        }

        event.preventDefault()
        event.stopPropagation()
        startResize(event.clientY)
      },
      [compact, enableResize, startResize],
    )

    const handleResizeHitboxDoubleClick = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        if (!enableResize || compact) {
          return
        }

        event.preventDefault()
        event.stopPropagation()
        setResizedHeight(null)
        void persistResizedHeight(null)
      },
      [compact, enableResize, persistResizedHeight],
    )

    const clearFileDragState = useCallback(() => {
      fileDragDepthRef.current = 0
      setIsFileDragActive(false)
    }, [])

    const handleContainerDragEnter = useCallback(
      (event: ReactDragEvent<HTMLDivElement>) => {
        if (compact || !isFileDragEvent(event)) {
          return
        }

        fileDragDepthRef.current += 1
        setIsFileDragActive(true)
      },
      [compact],
    )

    const handleContainerDragOver = useCallback(
      (event: ReactDragEvent<HTMLDivElement>) => {
        if (compact || !isFileDragEvent(event)) {
          return
        }

        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      },
      [compact],
    )

    const handleContainerDragLeave = useCallback(
      (event: ReactDragEvent<HTMLDivElement>) => {
        if (compact || !isFileDragEvent(event)) {
          return
        }

        fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1)
        if (fileDragDepthRef.current === 0) {
          setIsFileDragActive(false)
        }
      },
      [compact],
    )

    const handleContainerDropCapture = useCallback(
      (event: ReactDragEvent<HTMLDivElement>) => {
        if (isFileDragEvent(event)) {
          clearFileDragState()
        }
      },
      [clearFileDragState],
    )

    const handleContainerMouseDown = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        if (compact) {
          return
        }

        const target = event.target as HTMLElement | null
        if (!target) {
          return
        }

        if (
          target.closest('.yolo-chat-user-input-send-row') ||
          target.closest('.yolo-chat-user-input-controls') ||
          target.closest('button') ||
          target.closest('[role="button"]')
        ) {
          return
        }

        if (target.closest('.mention')) {
          return
        }

        requestAnimationFrame(() => {
          coreRef.current?.focus()
        })
      },
      [compact],
    )

    const containerStyle = useMemo<CSSProperties | undefined>(() => {
      if (!enableResize || compact || resizedHeight === null) {
        return undefined
      }

      return {
        ['--yolo-chat-user-input-height' as string]: `${resizedHeight}px`,
      }
    }, [compact, enableResize, resizedHeight])

    const renderChatModeControl = () =>
      onChatModeChange && chatMode ? (
        <ChatModeSelect
          mode={chatMode}
          onChange={onChatModeChange}
          yoloEnabled={yoloEnabled}
          onYoloChange={onYoloChange ?? (() => {})}
          side="top"
          sideOffset={8}
        />
      ) : null

    const renderModelControl = () => (
      <ModelSelect
        modelId={modelId}
        onChange={onModelChange}
        onMenuOpenChange={onControlPopoverOpenChange}
        align="center"
        sideOffset={8}
        popover={{
          variant: 'default',
          minWidth: 240,
          maxWidth: 320,
          maxHeight: 560,
        }}
      />
    )

    const renderReasoningControl = () =>
      showReasoningSelect && supportsReasoning(currentModel) ? (
        <ReasoningSelect
          model={currentModel}
          value={resolvedReasoningLevel}
          onChange={(level) => onReasoningChange?.(level)}
          onMenuOpenChange={onControlPopoverOpenChange}
          side="top"
          sideOffset={8}
        />
      ) : null

    const renderContextUsageControl = () =>
      contextUsage ? (
        contextUsage.buildBreakdownInputs ? (
          <ContextUsagePopover
            promptTokens={contextUsage.promptTokens}
            maxContextTokens={contextUsage.maxContextTokens}
            label={contextUsage.label}
            anchorRef={containerRef}
            buildInputs={contextUsage.buildBreakdownInputs}
          />
        ) : (
          <ContextUsageRing
            promptTokens={contextUsage.promptTokens}
            maxContextTokens={contextUsage.maxContextTokens}
            label={contextUsage.label}
          />
        )
      ) : null

    const renderSubmitControl = () => (
      <SubmitButton
        onClick={() => coreRef.current?.submit()}
        isGenerating={isGenerating}
        canQueue={canQueueWhileGenerating}
        onAbort={onAbort}
        disabled={submitDisabled}
      />
    )

    const handleQuickAccessSkillSelect = (skill: {
      name: string
      description: string
      path: string
    }) => {
      if (!setSelectedSkills) return
      const currentSkills = selectedSkillsRef.current
      if (currentSkills.some((selected) => selected.name === skill.name)) {
        coreRef.current?.focus()
        return
      }
      const nextSkills = [...currentSkills, skill]
      selectedSkillsRef.current = nextSkills
      setSelectedSkills(nextSkills)
      coreRef.current?.insertSkill(skill)
    }

    const handleQuickAccessSnippetSelect = (snippet: { content: string }) => {
      coreRef.current?.insertText(snippet.content)
      requestAnimationFrame(() => coreRef.current?.focus())
    }

    return (
      <div
        className={`yolo-chat-user-input-wrapper${compact ? ' yolo-chat-user-input-wrapper--compact' : ''}`}
        role="presentation"
      >
        {enableResize && !compact && (
          <div
            className="yolo-chat-user-input-resize-hitbox"
            onMouseDown={handleResizeHitboxMouseDown}
            onDoubleClick={handleResizeHitboxDoubleClick}
            role="presentation"
          />
        )}
        {mentionDisplayMode === 'badge' &&
          effectiveSelectedSkills.length > 0 && (
            <div className="yolo-chat-user-input-files">
              {effectiveSelectedSkills.map((skill) => (
                <ChatSkillBadge
                  key={skill.name}
                  skill={skill}
                  onDelete={() => handleDeleteSelectedSkill(skill.name)}
                />
              ))}
            </div>
          )}
        {!hideBadgeMentionables &&
          mentionDisplayMode === 'badge' &&
          effectiveMentionables.length > 0 && (
            <div className="yolo-chat-user-input-files">
              {effectiveMentionables.map((mentionable) => {
                const mentionableKey = getMentionableKey(
                  serializeMentionable(mentionable),
                )
                return (
                  <MentionableBadge
                    key={mentionableKey}
                    mentionable={mentionable}
                    onDelete={() =>
                      handleDeleteMentionableFromBadge(mentionable)
                    }
                    onClick={() => {}}
                  />
                )
              })}
            </div>
          )}
        <div
          className="yolo-chat-user-input-container"
          ref={containerRef}
          data-resizable={enableResize && !compact ? 'true' : 'false'}
          data-file-drag-active={isFileDragActive ? 'true' : 'false'}
          onClick={compact ? onToggleCompact : undefined}
          onKeyDown={
            compact
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onToggleCompact?.()
                  }
                }
              : undefined
          }
          onMouseDown={handleContainerMouseDown}
          onDragEnter={handleContainerDragEnter}
          onDragOver={handleContainerDragOver}
          onDragLeave={handleContainerDragLeave}
          onDropCapture={handleContainerDropCapture}
          role={compact ? 'button' : 'presentation'}
          tabIndex={compact ? 0 : undefined}
          style={containerStyle}
        >
          {isFileDragActive && (
            <div className="yolo-chat-user-input-drop-hint" aria-hidden="true">
              <FilePlus2 size={24} />
              <span>{t('chat.dropFilesHint', '松开以添加文件')}</span>
            </div>
          )}
          <div className="yolo-chat-user-input-editor" role="presentation">
            {isTextEmpty &&
              effectiveMentionables.length === 0 &&
              effectiveSelectedSkills.length === 0 &&
              compact && (
                <div className="yolo-chat-user-input-placeholder">
                  {t('chat.placeholderCompact', '点击展开编辑...')}
                </div>
              )}
            {showPlaceholder &&
              !compact &&
              isTextEmpty &&
              effectiveMentionables.length === 0 &&
              effectiveSelectedSkills.length === 0 && (
                <div className="yolo-chat-user-input-placeholder">
                  {t('chat.placeholderPrefix', '输入消息...')}{' '}
                  <span
                    className="yolo-placeholder-trigger"
                    role="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      handleTriggerClick('@')
                    }}
                  >
                    @
                  </span>
                  {t('chat.placeholderMention', '添加引用或模型')}
                  {'，'}
                  <span
                    className="yolo-placeholder-trigger"
                    role="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      handleTriggerClick('/')
                    }}
                  >
                    /
                  </span>
                  {t('chat.placeholderSkill', '选择技能或命令')}
                </div>
              )}
            <MessageInputCore
              ref={coreRef}
              initialSerializedEditorState={editorSeed.content}
              replacementVersion={editorSeed.replacementVersion}
              onChange={handleChange}
              onTextContentChange={handleTextContentChange}
              onEnter={handleEnter}
              onFocus={onFocus}
              autoFocus={autoFocus}
              mentionables={mentionables}
              setMentionables={setMentionables}
              mentionDisplayMode={mentionDisplayMode}
              onDeleteFromAll={onDeleteFromAll}
              displayMentionablesForDelete={effectiveMentionables}
              enableSkills
              enableAttachments
              selectedSkills={selectedSkills}
              setSelectedSkills={setSelectedSkills}
              currentModel={currentModel}
              mentionMenuMode={
                onSelectAssistantForConversation ||
                onSelectChatModeForConversation
                  ? 'entry'
                  : 'direct-search'
              }
              assistants={availableAssistants}
              currentAssistantId={currentAssistantId}
              onSelectAssistant={onSelectAssistantForConversation}
              currentChatMode={currentChatMode}
              onSelectChatMode={onSelectChatModeForConversation}
              allowAgentModeOption={allowAgentModeOption}
              models={enabledChatModels}
              skills={availableSkills}
              snippets={availableSnippets}
              onCreateSnippetsFile={handleCreateSnippetsFile}
              onRunSlashCommand={onRunSlashCommand}
            />
          </div>

          {!compact && controlLayout === 'inline' && (
            <div className="yolo-chat-user-input-controls">
              <div className="yolo-chat-user-input-controls__left">
                <FileUploadButton
                  onUpload={(files) => coreRef.current?.uploadFiles(files)}
                />
                {renderModelControl()}
                {renderReasoningControl()}
              </div>
              <div className="yolo-chat-user-input-controls__right">
                {renderContextUsageControl()}
                {renderSubmitControl()}
              </div>
            </div>
          )}

          {!compact && controlLayout === 'composer-toolbar' && (
            <div className="yolo-chat-user-input-send-row">
              <FileUploadButton
                onUpload={(files) => coreRef.current?.uploadFiles(files)}
              />
              <div className="yolo-chat-user-input-send-row__right">
                {renderContextUsageControl()}
                {renderSubmitControl()}
              </div>
            </div>
          )}
        </div>
        {!compact && controlLayout === 'composer-toolbar' && (
          <div className="yolo-chat-user-input-toolbar">
            <div className="yolo-chat-user-input-toolbar__left">
              {renderChatModeControl()}
            </div>
            <div className="yolo-chat-user-input-toolbar__right">
              {renderModelControl()}
              {renderReasoningControl()}
            </div>
          </div>
        )}
        <AnimatePresence initial={false} mode="popLayout">
          {showQuickAccess && !compact ? (
            <motion.div
              key="quick-access"
              className="yolo-chat-quick-access-motion"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{
                duration: reduceMotion ? 0 : 0.12,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              <ChatQuickAccess
                skills={availableSkills}
                snippets={availableSnippets}
                onSelectSkill={handleQuickAccessSkillSelect}
                onSelectSnippet={handleQuickAccessSnippetSelect}
                onPopoverOpenChange={onControlPopoverOpenChange}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    )
  },
)

ChatUserInput.displayName = 'ChatUserInput'

export default memo(ChatUserInput)
