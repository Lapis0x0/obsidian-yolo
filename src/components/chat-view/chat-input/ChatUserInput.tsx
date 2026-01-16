import { useQuery } from '@tanstack/react-query'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $nodesOfType,
  LexicalEditor,
  type LexicalNode,
  type ParagraphNode,
  SerializedEditorState,
} from 'lexical'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useApp } from '../../../contexts/app-context'
import { useSettings } from '../../../contexts/settings-context'
import { ChatModel } from '../../../types/chat-model.types'
import { ConversationOverrideSettings } from '../../../types/conversation-settings.types'
import {
  Mentionable,
  MentionableImage,
  SerializedMentionable,
} from '../../../types/mentionable'
import {
  deserializeMentionable,
  getMentionableKey,
  getMentionableName,
  serializeMentionable,
} from '../../../utils/chat/mentionable'
import { readTFileContent } from '../../../utils/obsidian'
import { ObsidianMarkdown } from '../ObsidianMarkdown'

import { ChatMode, ChatModeSelect } from './ChatModeSelect'
import LexicalContentEditable from './LexicalContentEditable'
import MentionableBadge from './MentionableBadge'
import { ModelSelect } from './ModelSelect'
import {
  $createMentionNode,
  $isMentionNode,
  MentionNode,
} from './plugins/mention/MentionNode'
import { NodeMutations } from './plugins/on-mutation/OnMutationPlugin'
import {
  ReasoningLevel,
  ReasoningSelect,
  supportsReasoning,
} from './ReasoningSelect'
import { SubmitButton } from './SubmitButton'
import ToolBadge from './ToolBadge'

export type ChatUserInputRef = {
  focus: () => void
  insertText: (text: string) => void
}

export type ChatUserInputProps = {
  initialSerializedEditorState: SerializedEditorState | null
  onChange: (content: SerializedEditorState) => void
  onSubmit: (content: SerializedEditorState, useVaultSearch?: boolean) => void
  onFocus: () => void
  mentionables: Mentionable[]
  setMentionables: (mentionables: Mentionable[]) => void
  autoFocus?: boolean
  addedBlockKey?: string | null
  conversationOverrides?: ConversationOverrideSettings | null
  onConversationOverridesChange?: (
    overrides: ConversationOverrideSettings | null,
  ) => void
  showConversationSettingsButton?: boolean
  modelId?: string
  onModelChange?: (modelId: string) => void
  // 用于显示聚合后的 mentionables（包含历史消息中的文件）
  displayMentionables?: Mentionable[]
  // 删除时从所有消息中删除的回调
  onDeleteFromAll?: (mentionable: Mentionable) => void
  // Chat mode (chat/agent)
  chatMode?: ChatMode
  onModeChange?: (mode: ChatMode) => void
  // Reasoning level
  reasoningLevel?: ReasoningLevel
  onReasoningChange?: (level: ReasoningLevel) => void
}

type ChatSubmitOptions = {
  useVaultSearch?: boolean
}

const ChatUserInput = forwardRef<ChatUserInputRef, ChatUserInputProps>(
  (
    {
      initialSerializedEditorState,
      onChange,
      onSubmit,
      onFocus,
      mentionables,
      setMentionables,
      autoFocus = false,
      addedBlockKey,
      conversationOverrides = null,
      onConversationOverridesChange: _onConversationOverridesChange,
      showConversationSettingsButton: _showConversationSettingsButton = false,
      modelId,
      onModelChange,
      displayMentionables,
      onDeleteFromAll,
      chatMode = 'chat',
      onModeChange,
      reasoningLevel = 'medium',
      onReasoningChange,
    },
    ref,
  ) => {
    const app = useApp()
    const { settings } = useSettings()

    // Get current model for reasoning support check
    const currentModel: ChatModel | null = useMemo(() => {
      if (!modelId) return null
      return settings.chatModels.find((m) => m.id === modelId) ?? null
    }, [modelId, settings.chatModels])

    const editorRef = useRef<LexicalEditor | null>(null)
    const contentEditableRef = useRef<HTMLDivElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const [isEditorReady, setIsEditorReady] = useState(false)

    const effectiveMentionables = useMemo(
      () => displayMentionables ?? mentionables,
      [displayMentionables, mentionables],
    )

    useEffect(() => {
      if (isEditorReady) return
      let animationFrame = 0
      const checkEditorReady = () => {
        if (editorRef.current) {
          setIsEditorReady(true)
          return
        }
        animationFrame = requestAnimationFrame(checkEditorReady)
      }
      checkEditorReady()
      return () => {
        if (animationFrame) {
          cancelAnimationFrame(animationFrame)
        }
      }
    }, [isEditorReady])

    const [displayedMentionableKey, setDisplayedMentionableKey] = useState<
      string | null
    >(addedBlockKey ?? null)

    useEffect(() => {
      if (addedBlockKey) {
        setDisplayedMentionableKey(addedBlockKey)
      }
    }, [addedBlockKey])

    useImperativeHandle(ref, () => ({
      focus: () => {
        contentEditableRef.current?.focus()
      },
      insertText: (text: string) => {
        if (!editorRef.current) return

        editorRef.current.update(() => {
          const selection = $getSelection()
          if ($isRangeSelection(selection)) {
            selection.insertText(text)
          } else {
            // If no selection, insert at the end
            const root = $getRoot()
            root.selectEnd()
            const newSelection = $getSelection()
            if ($isRangeSelection(newSelection)) {
              newSelection.insertText(text)
            }
          }
        })

        // Focus the editor after inserting
        contentEditableRef.current?.focus()
      },
    }))

    const handleMentionNodeMutation = (
      mutations: NodeMutations<MentionNode>,
    ) => {
      const destroyedMentionableKeys: string[] = []
      const addedMentionables: SerializedMentionable[] = []
      mutations.forEach((mutation) => {
        const mentionable = mutation.node.getMentionable()
        const mentionableKey = getMentionableKey(mentionable)

        if (mutation.mutation === 'destroyed') {
          const nodeWithSameMentionable = editorRef.current?.read(() =>
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
            effectiveMentionables.some(
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

      if (destroyedMentionableKeys.length > 0 && onDeleteFromAll) {
        destroyedMentionableKeys.forEach((mentionableKey) => {
          const mentionable = effectiveMentionables.find(
            (m) =>
              getMentionableKey(serializeMentionable(m)) === mentionableKey,
          )
          if (mentionable) {
            onDeleteFromAll(mentionable)
          }
        })
      }

      if (!onDeleteFromAll || addedMentionables.length > 0) {
        setMentionables(
          mentionables
            .filter(
              (m) =>
                !destroyedMentionableKeys.includes(
                  getMentionableKey(serializeMentionable(m)),
                ),
            )
            .concat(
              addedMentionables
                .map((m) => deserializeMentionable(m, app))
                .filter((v) => !!v),
            ),
        )
      }
      // 默认保持收起状态，不自动展开新添加的徽章
    }

    useEffect(() => {
      const editor = editorRef.current
      if (!editor || !isEditorReady || effectiveMentionables.length === 0)
        return

      const mentionablesToMirror = effectiveMentionables.filter((m) =>
        ['file', 'folder', 'current-file', 'image', 'block'].includes(m.type),
      )
      if (mentionablesToMirror.length === 0) return

      const shouldMoveCursor =
        contentEditableRef.current === document.activeElement

      editor.update(() => {
        const existingKeys = new Set(
          $nodesOfType(MentionNode).map((node) =>
            getMentionableKey(node.getMentionable()),
          ),
        )
        const root = $getRoot()
        let paragraphNode = root.getFirstChild()
        if (!paragraphNode || !$isParagraphNode(paragraphNode)) {
          const created = $createParagraphNode()
          root.append(created)
          paragraphNode = created
        }
        const paragraph = paragraphNode as ParagraphNode
        const insertBefore = paragraph.getFirstChild()

        let didInsert = false
        mentionablesToMirror.forEach((mentionable) => {
          const serialized = serializeMentionable(mentionable)
          const mentionableKey = getMentionableKey(serialized)
          if (existingKeys.has(mentionableKey)) return

          const mentionNode = $createMentionNode(
            getMentionableName(mentionable),
            serialized,
          )
          const spacer = $createTextNode(' ')
          if (insertBefore) {
            insertBefore.insertBefore(spacer)
            insertBefore.insertBefore(mentionNode)
          } else {
            paragraph.append(mentionNode)
            paragraph.append(spacer)
          }
          didInsert = true
        })

        if (!shouldMoveCursor) return
        const selection = $getSelection()
        if (
          !selection ||
          !$isRangeSelection(selection) ||
          !selection.isCollapsed()
        ) {
          return
        }
        const anchorNode = selection.anchor.getNode()
        const anchorTopLevel = anchorNode.getTopLevelElement()
        if (anchorTopLevel && anchorTopLevel !== paragraph) return
        if (selection.anchor.offset !== 0 || anchorNode.getPreviousSibling()) {
          return
        }
        const hasUserText = paragraph
          .getChildren()
          .some((node: LexicalNode) => {
            if ($isMentionNode(node)) return false
            return node.getTextContent().trim().length > 0
          })
        if (hasUserText) return
        const hasMentionables = paragraph
          .getChildren()
          .some((node: LexicalNode) => $isMentionNode(node))
        if (!didInsert && !hasMentionables) return
        paragraph.selectEnd()
      })
    }, [effectiveMentionables, isEditorReady])

    const handleCreateImageMentionables = useCallback(
      (mentionableImages: MentionableImage[]) => {
        const newMentionableImages = mentionableImages.filter(
          (m) =>
            !mentionables.some(
              (mentionable) =>
                getMentionableKey(serializeMentionable(mentionable)) ===
                getMentionableKey(serializeMentionable(m)),
            ),
        )
        if (newMentionableImages.length === 0) return
        setMentionables([...mentionables, ...newMentionableImages])
        // 默认保持收起状态，不自动展开新添加的徽章
      },
      [mentionables, setMentionables],
    )

    const handleMentionableDelete = (mentionable: Mentionable) => {
      const mentionableKey = getMentionableKey(
        serializeMentionable(mentionable),
      )

      // 如果提供了 onDeleteFromAll，调用它来从所有消息中删除
      if (onDeleteFromAll) {
        onDeleteFromAll(mentionable)
      } else {
        // 否则只从当前消息中删除
        setMentionables(
          mentionables.filter(
            (m) =>
              getMentionableKey(serializeMentionable(m)) !== mentionableKey,
          ),
        )
      }

      // 从编辑器中移除对应的 MentionNode
      editorRef.current?.update(() => {
        $nodesOfType(MentionNode).forEach((node) => {
          if (getMentionableKey(node.getMentionable()) === mentionableKey) {
            node.remove()
          }
        })
      })
    }

    const handleSubmit = (options: ChatSubmitOptions = {}) => {
      const content = editorRef.current?.getEditorState()?.toJSON()
      // Use vault search from conversation overrides if available, otherwise use the passed option
      const shouldUseVaultSearch =
        conversationOverrides?.useVaultSearch ?? options.useVaultSearch
      if (content) {
        onSubmit(content, shouldUseVaultSearch)
      }
    }

    return (
      <div className="smtcmp-chat-user-input-wrapper">
        <div className="smtcmp-chat-user-input-tools-row">
          <ToolBadge />
        </div>
        <div className="smtcmp-chat-user-input-container" ref={containerRef}>
          <div className="smtcmp-chat-user-input-files">
            {(displayMentionables ?? mentionables).map((m) => {
              const mentionableKey = getMentionableKey(serializeMentionable(m))
              const isExpanded = mentionableKey === displayedMentionableKey
              const handleToggleExpand = () => {
                if (isExpanded) {
                  setDisplayedMentionableKey(null)
                } else {
                  setDisplayedMentionableKey(mentionableKey)
                }
              }
              return (
                <MentionableBadge
                  key={mentionableKey}
                  mentionable={m}
                  onDelete={() => handleMentionableDelete(m)}
                  onClick={handleToggleExpand}
                  isFocused={isExpanded}
                  isExpanded={isExpanded}
                  onToggleExpand={handleToggleExpand}
                />
              )
            })}
          </div>

          <MentionableContentPreview
            displayedMentionableKey={displayedMentionableKey}
            mentionables={displayMentionables ?? mentionables}
          />

          <LexicalContentEditable
            initialEditorState={(editor) => {
              if (initialSerializedEditorState) {
                editor.setEditorState(
                  editor.parseEditorState(initialSerializedEditorState),
                )
              }
            }}
            editorRef={editorRef}
            contentEditableRef={contentEditableRef}
            onChange={onChange}
            onEnter={() => handleSubmit()}
            onFocus={onFocus}
            onMentionNodeMutation={handleMentionNodeMutation}
            onCreateImageMentionables={handleCreateImageMentionables}
            autoFocus={autoFocus}
            plugins={{
              onEnter: {
                onVaultChat: () => {
                  handleSubmit()
                },
              },
            }}
          />

          <div className="smtcmp-chat-user-input-controls">
            <div className="smtcmp-chat-user-input-controls__left">
              <ChatModeSelect
                mode={chatMode}
                onChange={(mode) => onModeChange?.(mode)}
                side="top"
                sideOffset={8}
                contentClassName="smtcmp-smart-space-popover smtcmp-chat-sidebar-popover"
              />
              <ModelSelect
                modelId={modelId}
                onChange={onModelChange}
                align="start"
                sideOffset={8}
                contentClassName="smtcmp-smart-space-popover smtcmp-chat-sidebar-popover"
              />
              {supportsReasoning(currentModel) && (
                <ReasoningSelect
                  model={currentModel}
                  value={reasoningLevel}
                  onChange={(level) => onReasoningChange?.(level)}
                  side="top"
                  sideOffset={8}
                  contentClassName="smtcmp-smart-space-popover smtcmp-chat-sidebar-popover"
                />
              )}
            </div>
            <div className="smtcmp-chat-user-input-controls__right">
              <SubmitButton onClick={() => handleSubmit()} />
            </div>
          </div>
        </div>
      </div>
    )
  },
)

function MentionableContentPreview({
  displayedMentionableKey,
  mentionables,
}: {
  displayedMentionableKey: string | null
  mentionables: Mentionable[]
}) {
  const app = useApp()

  const displayedMentionable: Mentionable | null = useMemo(() => {
    return (
      mentionables.find(
        (m) =>
          getMentionableKey(serializeMentionable(m)) ===
          displayedMentionableKey,
      ) ?? null
    )
  }, [displayedMentionableKey, mentionables])

  const { data: displayFileContent } = useQuery({
    enabled:
      !!displayedMentionable &&
      ['file', 'current-file', 'block'].includes(displayedMentionable.type),
    queryKey: [
      'file',
      displayedMentionableKey,
      mentionables.map((m) => getMentionableKey(serializeMentionable(m))), // should be updated when mentionables change (especially on delete)
    ],
    queryFn: async () => {
      if (!displayedMentionable) return null
      if (
        displayedMentionable.type === 'file' ||
        displayedMentionable.type === 'current-file'
      ) {
        if (!displayedMentionable.file) return null
        return await readTFileContent(displayedMentionable.file, app.vault)
      } else if (displayedMentionable.type === 'block') {
        const fileContent = await readTFileContent(
          displayedMentionable.file,
          app.vault,
        )

        return fileContent
          .split('\n')
          .slice(
            displayedMentionable.startLine - 1,
            displayedMentionable.endLine,
          )
          .join('\n')
      }

      return null
    },
  })

  const displayImage: MentionableImage | null = useMemo(() => {
    return displayedMentionable?.type === 'image' ? displayedMentionable : null
  }, [displayedMentionable])

  return displayFileContent ? (
    <div className="smtcmp-chat-user-input-file-content-preview">
      <ObsidianMarkdown content={displayFileContent} scale="xs" />
    </div>
  ) : displayImage ? (
    <div className="smtcmp-chat-user-input-file-content-preview">
      <img src={displayImage.data} alt={displayImage.name} />
    </div>
  ) : null
}

ChatUserInput.displayName = 'ChatUserInput'

export default ChatUserInput
