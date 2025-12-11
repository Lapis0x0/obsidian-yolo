import { useQuery } from '@tanstack/react-query'
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $nodesOfType,
  LexicalEditor,
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
import { ConversationOverrideSettings } from '../../../types/conversation-settings.types'
import {
  Mentionable,
  MentionableImage,
  SerializedMentionable,
} from '../../../types/mentionable'
import {
  deserializeMentionable,
  getMentionableKey,
  serializeMentionable,
} from '../../../utils/chat/mentionable'
import { fileToMentionableImage } from '../../../utils/llm/image'
import { readTFileContent } from '../../../utils/obsidian'
import { ObsidianMarkdown } from '../ObsidianMarkdown'

import { ImageUploadButton } from './ImageUploadButton'
import LexicalContentEditable from './LexicalContentEditable'
import MentionableBadge from './MentionableBadge'
import { ModelSelect } from './ModelSelect'
import { MentionNode } from './plugins/mention/MentionNode'
import { NodeMutations } from './plugins/on-mutation/OnMutationPlugin'
import { SubmitButton } from './SubmitButton'
import ToolBadge from './ToolBadge'
import { SystemPromptToggle } from '../system-prompt/SystemPromptToggle'

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
    },
    ref,
  ) => {
    const app = useApp()

    const editorRef = useRef<LexicalEditor | null>(null)
    const contentEditableRef = useRef<HTMLDivElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)

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
      if (addedMentionables.length > 0) {
        setDisplayedMentionableKey(
          getMentionableKey(addedMentionables[addedMentionables.length - 1]),
        )
      }
    }

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
        setDisplayedMentionableKey(
          getMentionableKey(
            serializeMentionable(
              newMentionableImages[newMentionableImages.length - 1],
            ),
          ),
        )
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
            (m) => getMentionableKey(serializeMentionable(m)) !== mentionableKey,
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

    const handleUploadImages = (images: File[]) => {
      void Promise.all(
        images.map((image) => fileToMentionableImage(image)),
      ).then(handleCreateImageMentionables, (error) => {
        console.error('[Smart Composer] Failed to upload images:', error)
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
      <div className="smtcmp-chat-user-input-container" ref={containerRef}>
        <div className="smtcmp-chat-user-input-files">
          <ToolBadge />
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
          <div className="smtcmp-chat-user-input-controls__model-select-container smtcmp-chat-sidebar-model-select">
            <ModelSelect
              modelId={modelId}
              onChange={onModelChange}
              align="start"
              sideOffset={8}
              contentClassName="smtcmp-smart-space-popover smtcmp-chat-sidebar-popover"
            />
          </div>
          <div className="smtcmp-chat-user-input-controls__system-prompt-toggle">
            <SystemPromptToggle />
          </div>
          <div className="smtcmp-chat-user-input-controls__buttons">
            <ImageUploadButton onUpload={handleUploadImages} />
            <SubmitButton onClick={() => handleSubmit()} />
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
