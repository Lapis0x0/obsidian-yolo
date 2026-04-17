import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $nodesOfType,
  LexicalEditor,
  type LexicalNode,
  type ParagraphNode,
  SerializedEditorState,
} from 'lexical'
import { Notice } from 'obsidian'
import {
  type CSSProperties,
  type FocusEvent,
  type MouseEvent as ReactMouseEvent,
  forwardRef,
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
import { listLiteSkillEntries } from '../../../core/skills/liteSkills'
import { isSkillEnabledForAssistant } from '../../../core/skills/skillPolicy'
import { ChatSelectedSkill } from '../../../types/chat'
import { ChatModel } from '../../../types/chat-model.types'
import {
  Mentionable,
  MentionableImage,
  SerializedMentionable,
} from '../../../types/mentionable'
import { getDisplayOnlyCurrentFileMentionables } from '../../../utils/chat/currentFileMentionable'
import {
  deserializeMentionable,
  getMentionableKey,
  getMentionableName,
  serializeMentionable,
} from '../../../utils/chat/mentionable'
import { fileToMentionableImage } from '../../../utils/llm/image'

import ChatSkillBadge from './ChatSkillBadge'
import { ImageUploadButton } from './ImageUploadButton'
import LexicalContentEditable from './LexicalContentEditable'
import MentionableBadge from './MentionableBadge'
import { ModelSelect } from './ModelSelect'
import {
  $createMentionNode,
  $isMentionNode,
  MentionNode,
} from './plugins/mention/MentionNode'
import {
  $createSkillNode,
  $isSkillNode,
  SkillNode,
} from './plugins/mention/SkillNode'
import type { SlashCommand } from './plugins/mention/SkillSlashPlugin'
import { NodeMutations } from './plugins/on-mutation/OnMutationPlugin'
import {
  ReasoningLevel,
  ReasoningSelect,
  getDefaultReasoningLevel,
  supportsReasoning,
} from './ReasoningSelect'
import { SubmitButton } from './SubmitButton'

export type ChatUserInputRef = {
  focus: () => void
  insertText: (text: string) => void
  appendText: (text: string) => void
  replaceText: (text: string) => void
  submit: () => void
}

export type ChatUserInputProps = {
  initialSerializedEditorState: SerializedEditorState | null
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
  onBlur?: () => void
  currentAssistantId?: string
  onSelectAssistantForConversation?: (assistantId: string) => void
  currentChatMode?: 'chat' | 'agent'
  onSelectChatModeForConversation?: (mode: 'chat' | 'agent') => void
  allowAgentModeOption?: boolean
  enableResize?: boolean
  onRunSlashCommand?: (command: SlashCommand) => void
}

const INLINE_MENTIONABLE_TYPES = [
  'file',
  'folder',
  'current-file',
  'block',
  'assistant-quote',
  'model',
]
const DEFAULT_INPUT_HEIGHT = 80
const MIN_INPUT_HEIGHT = 80
const MAX_INPUT_HEIGHT = 520

const ChatUserInput = forwardRef<ChatUserInputRef, ChatUserInputProps>(
  (
    {
      initialSerializedEditorState,
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
      onBlur,
      currentAssistantId,
      onSelectAssistantForConversation,
      currentChatMode,
      onSelectChatModeForConversation,
      allowAgentModeOption = true,
      enableResize = false,
      onRunSlashCommand,
    },
    ref,
  ) => {
    const app = useApp()
    const { t } = useLanguage()
    const mentionableUnitLabel = useMemo(
      () => t('common.characters', 'chars'),
      [t],
    )
    const { settings, setSettings } = useSettings()
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

    // Get current model for reasoning support check
    const currentModel: ChatModel | null = useMemo(() => {
      if (!modelId) return null
      return settings.chatModels.find((m) => m.id === modelId) ?? null
    }, [modelId, settings.chatModels])

    const editorRef = useRef<LexicalEditor | null>(null)
    const contentEditableRef = useRef<HTMLDivElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const [isEditorReady, setIsEditorReady] = useState(false)
    const suppressedDestroyedMentionableKeysRef = useRef<Set<string>>(new Set())
    const suppressedDestroyedSkillIdsRef = useRef<Set<string>>(new Set())
    const [inputText, setInputText] = useState('')
    const [resizedHeight, setResizedHeight] = useState<number | null>(
      rememberedInputHeight,
    )
    const resizedHeightRef = useRef<number | null>(rememberedInputHeight)
    const dragStartYRef = useRef(0)
    const dragStartHeightRef = useRef(DEFAULT_INPUT_HEIGHT)

    const effectiveMentionables = useMemo(
      () => displayMentionables ?? mentionables,
      [displayMentionables, mentionables],
    )
    const displayOnlyCurrentFileMentionables = useMemo(
      () =>
        getDisplayOnlyCurrentFileMentionables(
          mentionables,
          displayMentionables,
        ),
      [displayMentionables, mentionables],
    )
    const displayOnlyCurrentFileMentionableKeys = useMemo(
      () =>
        new Set(
          displayOnlyCurrentFileMentionables.map((mentionable) =>
            getMentionableKey(serializeMentionable(mentionable)),
          ),
        ),
      [displayOnlyCurrentFileMentionables],
    )
    const inlineMentionables = useMemo(() => {
      if (mentionDisplayMode !== 'inline') {
        return [] as Mentionable[]
      }

      return [...displayOnlyCurrentFileMentionables, ...mentionables]
    }, [displayOnlyCurrentFileMentionables, mentionDisplayMode, mentionables])
    const effectiveSelectedSkills = useMemo(
      () => selectedSkills,
      [selectedSkills],
    )
    const enabledChatModels = useMemo(
      () => settings.chatModels.filter((model) => model.enable ?? true),
      [settings.chatModels],
    )
    const selectedModelIds = useMemo(
      () =>
        mentionables
          .filter(
            (
              mentionable,
            ): mentionable is Mentionable & {
              type: 'model'
              modelId: string
            } => mentionable.type === 'model',
          )
          .map((mentionable) => mentionable.modelId),
      [mentionables],
    )

    const availableSkills = useMemo(() => {
      const assistants = settings.assistants || []
      const currentAssistant = currentAssistantId
        ? (assistants.find(
            (assistant) => assistant.id === currentAssistantId,
          ) ?? null)
        : null

      if (!currentAssistant) {
        return []
      }

      const disabledSkillIds = settings.skills?.disabledSkillIds ?? []
      return listLiteSkillEntries(app, { settings }).filter((skill) =>
        isSkillEnabledForAssistant({
          assistant: currentAssistant,
          skillId: skill.id,
          disabledSkillIds,
          defaultLoadMode: skill.mode,
        }),
      )
    }, [app, currentAssistantId, settings])

    const resolvedReasoningLevel = useMemo(() => {
      if (reasoningLevel) return reasoningLevel
      return getDefaultReasoningLevel(currentModel)
    }, [currentModel, reasoningLevel])

    const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
      if (!onBlur) return
      const nextTarget = event.relatedTarget as Node | null
      if (
        nextTarget &&
        nextTarget instanceof HTMLElement &&
        nextTarget.closest('.smtcmp-chat-sidebar-popover')
      ) {
        return
      }
      if (nextTarget && event.currentTarget.contains(nextTarget)) return
      onBlur()
    }

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

    useEffect(() => {
      if (!isEditorReady || !editorRef.current) return
      editorRef.current.getEditorState().read(() => {
        setInputText($getRoot().getTextContent())
      })
    }, [isEditorReady])

    useEffect(() => {
      if (!compact) {
        return
      }

      const activeElement = document.activeElement
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
        document.body.setCssProps({
          '--smtcmp-chat-input-resize-cursor': '',
          '--smtcmp-chat-input-resize-user-select': '',
        })
      }
    }, [])

    useImperativeHandle(ref, () => ({
      focus: () => {
        contentEditableRef.current?.focus()
      },
      insertText: (text: string) => {
        if (!editorRef.current) return

        editorRef.current.update(
          () => {
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
          },
          { discrete: true },
        )

        // Focus the editor after inserting
        contentEditableRef.current?.focus()
      },
      appendText: (text: string) => {
        if (!editorRef.current) return

        editorRef.current.update(
          () => {
            const root = $getRoot()
            root.selectEnd()
            const selection = $getSelection()
            if ($isRangeSelection(selection)) {
              selection.insertText(text)
            }
          },
          { discrete: true },
        )

        contentEditableRef.current?.focus()
      },
      replaceText: (text: string) => {
        if (!editorRef.current) return

        editorRef.current.update(
          () => {
            const root = $getRoot()
            root.clear()
            const paragraph = $createParagraphNode()
            if (text) {
              paragraph.append($createTextNode(text))
            }
            root.append(paragraph)
            paragraph.selectEnd()
          },
          { discrete: true },
        )

        contentEditableRef.current?.focus()
      },
      submit: () => {
        handleSubmit()
      },
    }))

    const handleMentionNodeMutation = (
      mutations: NodeMutations<MentionNode>,
    ) => {
      const destroyedMentionableKeys: string[] = []
      const addedMentionables: SerializedMentionable[] = []
      let hasDanglingLightweightBlockToken = false
      mutations.forEach((mutation) => {
        const mentionable = mutation.node.getMentionable()
        const mentionableKey = getMentionableKey(mentionable)

        if (mutation.mutation === 'destroyed') {
          if (
            suppressedDestroyedMentionableKeysRef.current.has(mentionableKey)
          ) {
            suppressedDestroyedMentionableKeysRef.current.delete(mentionableKey)
            return
          }

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
            mentionable.type === 'current-file' &&
            displayOnlyCurrentFileMentionableKeys.has(mentionableKey)
          ) {
            return
          }

          if (
            mentionable.type === 'block' &&
            typeof mentionable.content !== 'string'
          ) {
            const existsInMentionables = mentionables.some(
              (m) =>
                getMentionableKey(serializeMentionable(m)) === mentionableKey,
            )
            if (!existsInMentionables) {
              hasDanglingLightweightBlockToken = true
            }
            return
          }

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

      if (hasDanglingLightweightBlockToken) {
        new Notice('Block reference pasted as text. Please reselect the block.')
      }

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

    const handleSkillNodeMutation = (mutations: NodeMutations<SkillNode>) => {
      if (!setSelectedSkills) {
        return
      }

      const destroyedSkillIds: string[] = []
      const addedSkills: ChatSelectedSkill[] = []

      mutations.forEach((mutation) => {
        const skill = mutation.node.getSkill()
        if (mutation.mutation === 'destroyed') {
          if (suppressedDestroyedSkillIdsRef.current.has(skill.id)) {
            suppressedDestroyedSkillIdsRef.current.delete(skill.id)
            return
          }

          const nodeWithSameSkill = editorRef.current?.read(() =>
            $nodesOfType(SkillNode).find(
              (node) => node.getSkill().id === skill.id,
            ),
          )

          if (!nodeWithSameSkill) {
            destroyedSkillIds.push(skill.id)
          }
          return
        }

        if (
          effectiveSelectedSkills.some(
            (selectedSkill) => selectedSkill.id === skill.id,
          ) ||
          addedSkills.some((selectedSkill) => selectedSkill.id === skill.id)
        ) {
          return
        }

        addedSkills.push(skill)
      })

      if (destroyedSkillIds.length === 0 && addedSkills.length === 0) {
        return
      }

      setSelectedSkills(
        effectiveSelectedSkills
          .filter((skill) => !destroyedSkillIds.includes(skill.id))
          .concat(addedSkills),
      )
    }

    useEffect(() => {
      const editor = editorRef.current
      if (!editor || !isEditorReady) return

      const mirrorTypes =
        mentionDisplayMode === 'inline' ? INLINE_MENTIONABLE_TYPES : []
      const mentionablesToMirror = inlineMentionables.filter((m) =>
        mirrorTypes.includes(m.type),
      )
      const mentionablesByKey = new Map(
        mentionablesToMirror.map((mentionable) => [
          getMentionableKey(serializeMentionable(mentionable)),
          mentionable,
        ]),
      )

      const shouldMoveCursor =
        contentEditableRef.current === document.activeElement

      editor.update(() => {
        const mirrorTypeSet = new Set(INLINE_MENTIONABLE_TYPES)
        $nodesOfType(MentionNode).forEach((node) => {
          const mentionable = node.getMentionable()
          if (!mirrorTypeSet.has(mentionable.type)) return
          const mentionableKey = getMentionableKey(mentionable)
          const desiredMentionable = mentionablesByKey.get(mentionableKey)
          if (!desiredMentionable) {
            suppressedDestroyedMentionableKeysRef.current.add(mentionableKey)
            const prevSibling = node.getPreviousSibling()
            if (
              prevSibling &&
              $isTextNode(prevSibling) &&
              prevSibling.getTextContent() === ' '
            ) {
              prevSibling.remove()
            } else {
              const nextSibling = node.getNextSibling()
              if (
                nextSibling &&
                $isTextNode(nextSibling) &&
                nextSibling.getTextContent() === ' '
              ) {
                nextSibling.remove()
              }
            }
            node.remove()
            return
          }
        })

        if (mentionablesToMirror.length === 0) return

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
        const cursorSelection = $getSelection()
        const canInsertAtCursor =
          $isRangeSelection(cursorSelection) && cursorSelection.isCollapsed()

        let didInsert = false
        mentionablesToMirror.forEach((mentionable) => {
          const serialized = serializeMentionable(mentionable)
          const mentionableKey = getMentionableKey(serialized)
          if (existingKeys.has(mentionableKey)) return

          const mentionNode = $createMentionNode(
            getMentionableName(mentionable, {
              unitLabel: mentionableUnitLabel,
            }),
            serialized,
          )
          const spacer = $createTextNode(' ')
          if (canInsertAtCursor) {
            cursorSelection.insertNodes([mentionNode, spacer])
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
    }, [
      inlineMentionables,
      isEditorReady,
      mentionDisplayMode,
      mentionableUnitLabel,
    ])

    useEffect(() => {
      const editor = editorRef.current
      if (!editor || !isEditorReady || !setSelectedSkills) return

      const skillsToMirror =
        mentionDisplayMode === 'inline' ? effectiveSelectedSkills : []
      const skillsById = new Map(
        skillsToMirror.map((skill) => [skill.id, skill] as const),
      )

      const shouldMoveCursor =
        contentEditableRef.current === document.activeElement

      editor.update(() => {
        $nodesOfType(SkillNode).forEach((node) => {
          const skill = node.getSkill()
          if (skillsById.has(skill.id)) return

          suppressedDestroyedSkillIdsRef.current.add(skill.id)
          const prevSibling = node.getPreviousSibling()
          if (
            prevSibling &&
            $isTextNode(prevSibling) &&
            prevSibling.getTextContent() === ' '
          ) {
            prevSibling.remove()
          } else {
            const nextSibling = node.getNextSibling()
            if (
              nextSibling &&
              $isTextNode(nextSibling) &&
              nextSibling.getTextContent() === ' '
            ) {
              nextSibling.remove()
            }
          }
          node.remove()
        })

        if (skillsToMirror.length === 0) return

        const existingIds = new Set(
          $nodesOfType(SkillNode).map((node) => node.getSkill().id),
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
        skillsToMirror.forEach((skill) => {
          if (existingIds.has(skill.id)) return

          const skillNode = $createSkillNode(skill.name, skill)
          const spacer = $createTextNode(' ')
          if (insertBefore) {
            insertBefore.insertBefore(spacer)
            insertBefore.insertBefore(skillNode)
          } else {
            paragraph.append(skillNode)
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
            if ($isMentionNode(node) || $isSkillNode(node)) return false
            return node.getTextContent().trim().length > 0
          })
        if (hasUserText) return
        const hasTokens = paragraph
          .getChildren()
          .some(
            (node: LexicalNode) => $isMentionNode(node) || $isSkillNode(node),
          )
        if (!didInsert && !hasTokens) return
        paragraph.selectEnd()
      })
    }, [
      effectiveSelectedSkills,
      isEditorReady,
      mentionDisplayMode,
      setSelectedSkills,
    ])

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
        const editor = editorRef.current
        if (editor) {
          editor.update(() => {
            const nodesToInsert: LexicalNode[] = []
            newMentionableImages.forEach((mentionable) => {
              nodesToInsert.push(
                $createMentionNode(
                  getMentionableName(mentionable, {
                    unitLabel: mentionableUnitLabel,
                  }),
                  serializeMentionable(mentionable),
                ),
              )
              nodesToInsert.push($createTextNode(' '))
            })
            const selection = $getSelection()
            if (selection && $isRangeSelection(selection)) {
              selection.insertNodes(nodesToInsert)
              return
            }

            const root = $getRoot()
            let paragraphNode = root.getFirstChild()
            if (!paragraphNode || !$isParagraphNode(paragraphNode)) {
              const created = $createParagraphNode()
              root.append(created)
              paragraphNode = created
            }
            const paragraph = paragraphNode as ParagraphNode
            nodesToInsert.forEach((node) => {
              paragraph.append(node)
            })
          })
        }
        setMentionables([...mentionables, ...newMentionableImages])
        // 默认保持收起状态，不自动展开新添加的徽章
      },
      [mentionableUnitLabel, mentionables, setMentionables],
    )

    const handleSelectMentionableForBadge = useCallback(
      (mentionable: Mentionable) => {
        if (mentionDisplayMode !== 'badge') return
        const mentionableKey = getMentionableKey(
          serializeMentionable(mentionable),
        )
        if (
          mentionables.some(
            (existing) =>
              getMentionableKey(serializeMentionable(existing)) ===
              mentionableKey,
          )
        ) {
          return
        }
        setMentionables([...mentionables, mentionable])
      },
      [mentionDisplayMode, mentionables, setMentionables],
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

    const handleSelectSkill = useCallback(
      (skill: {
        id: string
        name: string
        description: string
        path: string
      }) => {
        if (!setSelectedSkills) {
          return
        }

        const nextSkill: ChatSelectedSkill = {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          path: skill.path,
        }

        if (
          effectiveSelectedSkills.some(
            (selectedSkill) => selectedSkill.id === nextSkill.id,
          )
        ) {
          return
        }

        setSelectedSkills([...effectiveSelectedSkills, nextSkill])
      },
      [effectiveSelectedSkills, setSelectedSkills],
    )

    const handleDeleteSelectedSkill = useCallback(
      (skillId: string) => {
        if (!setSelectedSkills) {
          return
        }
        setSelectedSkills(
          effectiveSelectedSkills.filter((skill) => skill.id !== skillId),
        )
      },
      [effectiveSelectedSkills, setSelectedSkills],
    )

    const handleTriggerClick = useCallback(
      (char: string) => {
        if (!editorRef.current) return
        editorRef.current.update(
          () => {
            const root = $getRoot()
            root.selectEnd()
            const selection = $getSelection()
            if ($isRangeSelection(selection)) {
              selection.insertText(char)
            }
          },
          { discrete: true },
        )
        contentEditableRef.current?.focus()
      },
      [],
    )

    const handleSubmit = () => {
      const content = editorRef.current?.getEditorState()?.toJSON()
      if (content) {
        onSubmit(content)
      }
    }

    const handleEditorBackgroundMouseDown = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        const editorRoot = contentEditableRef.current
        const editor = editorRef.current
        if (!editorRoot || !editor) return

        // Only handle clicks on the contentEditable background itself.
        // This keeps normal caret placement when clicking on real text nodes.
        if (event.target !== editorRoot) return

        requestAnimationFrame(() => {
          editorRoot.focus()
          editor.update(() => {
            $getRoot().selectEnd()
          })
        })
      },
      [],
    )

    const clearResizeBodyStyles = useCallback(() => {
      document.body.setCssProps({
        '--smtcmp-chat-input-resize-cursor': '',
        '--smtcmp-chat-input-resize-user-select': '',
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
          contentEditableRef.current?.offsetHeight ??
          DEFAULT_INPUT_HEIGHT

        document.body.setCssProps({
          '--smtcmp-chat-input-resize-cursor': 'ns-resize',
          '--smtcmp-chat-input-resize-user-select': 'none',
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
          window.removeEventListener('mousemove', handleMouseMove)
          window.removeEventListener('mouseup', handleMouseUp)
          clearResizeBodyStyles()
          void persistResizedHeight(resizedHeightRef.current)
        }

        window.addEventListener('mousemove', handleMouseMove)
        window.addEventListener('mouseup', handleMouseUp)
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
          target.closest('.smtcmp-chat-user-input-controls') ||
          target.closest('button') ||
          target.closest('[role="button"]')
        ) {
          return
        }

        if (target.closest('.mention')) {
          return
        }

        requestAnimationFrame(() => {
          contentEditableRef.current?.focus()
        })
      },
      [compact],
    )

    const containerStyle = useMemo<CSSProperties | undefined>(() => {
      if (!enableResize || compact || resizedHeight === null) {
        return undefined
      }

      return {
        ['--smtcmp-chat-user-input-height' as string]: `${resizedHeight}px`,
      }
    }, [compact, enableResize, resizedHeight])

    return (
      <div
        className={`smtcmp-chat-user-input-wrapper${compact ? ' smtcmp-chat-user-input-wrapper--compact' : ''}`}
        onBlur={handleBlur}
        role="presentation"
      >
        {enableResize && !compact && (
          <div
            className="smtcmp-chat-user-input-resize-hitbox"
            onMouseDown={handleResizeHitboxMouseDown}
            onDoubleClick={handleResizeHitboxDoubleClick}
            role="presentation"
          />
        )}
        {mentionDisplayMode === 'badge' &&
          effectiveSelectedSkills.length > 0 && (
            <div className="smtcmp-chat-user-input-files">
              {effectiveSelectedSkills.map((skill) => (
                <ChatSkillBadge
                  key={skill.id}
                  skill={skill}
                  onDelete={() => handleDeleteSelectedSkill(skill.id)}
                />
              ))}
            </div>
          )}
        {!hideBadgeMentionables &&
          mentionDisplayMode === 'badge' &&
          effectiveMentionables.length > 0 && (
            <div className="smtcmp-chat-user-input-files">
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
          className="smtcmp-chat-user-input-container"
          ref={containerRef}
          data-resizable={enableResize && !compact ? 'true' : 'false'}
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
          role={compact ? 'button' : 'presentation'}
          tabIndex={compact ? 0 : undefined}
          style={containerStyle}
        >
          <div
            className="smtcmp-chat-user-input-editor"
            onMouseDown={handleEditorBackgroundMouseDown}
            role="presentation"
          >
            {inputText.trim().length === 0 &&
              effectiveMentionables.length === 0 &&
              effectiveSelectedSkills.length === 0 &&
              compact && (
                <div className="smtcmp-chat-user-input-placeholder">
                  {t('chat.placeholderCompact', '点击展开编辑...')}
                </div>
              )}
            {showPlaceholder &&
              !compact &&
              inputText.trim().length === 0 &&
              effectiveMentionables.length === 0 &&
              effectiveSelectedSkills.length === 0 && (
                <div className="smtcmp-chat-user-input-placeholder">
                  {t('chat.placeholderPrefix', '输入消息...')}
                  {' '}
                  <span
                    className="smtcmp-placeholder-trigger"
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
                    className="smtcmp-placeholder-trigger"
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
              onTextContentChange={setInputText}
              onEnter={() => handleSubmit()}
              onFocus={onFocus}
              onMentionNodeMutation={handleMentionNodeMutation}
              onSkillNodeMutation={handleSkillNodeMutation}
              onCreateImageMentionables={handleCreateImageMentionables}
              mentionDisplayMode={mentionDisplayMode}
              onSelectMentionable={handleSelectMentionableForBadge}
              mentionMenuMode={
                onSelectAssistantForConversation ||
                onSelectChatModeForConversation
                  ? 'entry'
                  : 'direct-search'
              }
              assistants={settings.assistants || []}
              currentAssistantId={currentAssistantId}
              onSelectAssistant={onSelectAssistantForConversation}
              currentChatMode={currentChatMode}
              onSelectChatMode={onSelectChatModeForConversation}
              allowAgentModeOption={allowAgentModeOption}
              models={enabledChatModels}
              selectedModelIds={selectedModelIds}
              skills={availableSkills}
              selectedSkillIds={effectiveSelectedSkills.map(
                (skill) => skill.id,
              )}
              onSelectSkill={handleSelectSkill}
              onRunSlashCommand={onRunSlashCommand}
              autoFocus={autoFocus}
              plugins={{
                onEnter: {
                  onVaultChat: () => {
                    handleSubmit()
                  },
                },
              }}
            />
          </div>

          {!compact && (
            <div className="smtcmp-chat-user-input-controls">
              <div className="smtcmp-chat-user-input-controls__left">
                <ModelSelect
                  modelId={modelId}
                  onChange={onModelChange}
                  align="start"
                  sideOffset={8}
                  alignOffset={-6}
                  contentClassName="smtcmp-smart-space-popover smtcmp-chat-sidebar-popover"
                />
                {showReasoningSelect && supportsReasoning(currentModel) && (
                  <ReasoningSelect
                    model={currentModel}
                    value={resolvedReasoningLevel}
                    onChange={(level) => onReasoningChange?.(level)}
                    side="top"
                    sideOffset={8}
                    contentClassName="smtcmp-smart-space-popover smtcmp-chat-sidebar-popover"
                  />
                )}
              </div>
              <div className="smtcmp-chat-user-input-controls__right">
                <ImageUploadButton
                  onUpload={(files) => {
                    void Promise.all(
                      files.map((file) => fileToMentionableImage(file)),
                    )
                      .then((mentionableImages) => {
                        handleCreateImageMentionables(mentionableImages)
                      })
                      .catch((error) => {
                        console.error(
                          'Failed to process uploaded images',
                          error,
                        )
                      })
                  }}
                />
                <SubmitButton onClick={() => handleSubmit()} />
              </div>
            </div>
          )}
        </div>
      </div>
    )
  },
)

ChatUserInput.displayName = 'ChatUserInput'

export default ChatUserInput
