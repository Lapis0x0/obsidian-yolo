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
  type MouseEvent as ReactMouseEvent,
  type RefObject,
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
import { LiteSkillEntry } from '../../../core/skills/liteSkills'
import { SnippetEntry } from '../../../core/snippets/snippetsManager'
import { Assistant } from '../../../types/assistant.types'
import { ChatSelectedSkill } from '../../../types/chat'
import { ChatModel } from '../../../types/chat-model.types'
import {
  Mentionable,
  MentionableImage,
  MentionableOffice,
  MentionablePDF,
  MentionableTextAttachment,
  SerializedMentionable,
} from '../../../types/mentionable'
import {
  deserializeMentionable,
  getMentionableKey,
  getMentionableName,
  serializeMentionable,
} from '../../../utils/chat/mentionable'
import { fileToMentionableImage } from '../../../utils/llm/image'
import { chatModelSupportsVision } from '../../../utils/llm/model-modalities'
import { fileToMentionableOffice } from '../../../utils/llm/office'
import { fileToMentionablePDF } from '../../../utils/llm/pdf'
import { fileToMentionableTextAttachment } from '../../../utils/llm/text-attachment'

import { ChatMode } from './ChatModeSelect'
import LexicalContentEditable from './LexicalContentEditable'
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
import { classifyUploadFiles } from './utils/file-upload'

export type MessageInputCoreRef = {
  focus: () => void
  focusEnd: () => void
  insertText: (text: string) => void
  appendText: (text: string) => void
  replaceText: (text: string) => void
  submit: () => void
  uploadFiles: (files: File[]) => void
}

export type MessageInputCoreProps = {
  initialSerializedEditorState: SerializedEditorState | null
  replacementVersion?: number
  onChange: (content: SerializedEditorState) => void
  onTextContentChange?: (text: string) => void
  onEnter: () => void
  onFocus?: () => void
  autoFocus?: boolean
  disabled?: boolean
  className?: string
  contentClassName?: string
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onEditorBackgroundMouseDown?: (
    event: React.MouseEvent<HTMLDivElement>,
  ) => void

  mentionables: Mentionable[]
  setMentionables: (mentionables: Mentionable[]) => void
  mentionDisplayMode?: 'inline' | 'badge'
  onDeleteFromAll?: (mentionable: Mentionable) => void
  displayMentionablesForDelete?: Mentionable[]

  enableSkills?: boolean
  selectedSkills?: ChatSelectedSkill[]
  setSelectedSkills?: (skills: ChatSelectedSkill[]) => void

  enableAttachments?: boolean
  currentModel?: ChatModel | null

  mentionMenuMode?: 'direct-search' | 'entry'
  assistants?: Assistant[]
  currentAssistantId?: string
  onSelectAssistant?: (assistantId: string) => void
  currentChatMode?: ChatMode
  onSelectChatMode?: (mode: ChatMode) => void
  allowAgentModeOption?: boolean
  models?: ChatModel[]
  skills?: LiteSkillEntry[]
  snippets?: SnippetEntry[]
  onCreateSnippetsFile?: () => void
  onRunSlashCommand?: (command: SlashCommand) => void
  onMentionMenuToggle?: (isOpen: boolean) => void
  mentionMenuPlacement?: 'top' | 'bottom'
  mentionMenuContainerRef?: RefObject<HTMLElement>
}

const INLINE_MENTIONABLE_TYPES = [
  'file',
  'folder',
  'block',
  'assistant-quote',
  'web-selection',
  'model',
  'image',
]

const MessageInputCore = forwardRef<MessageInputCoreRef, MessageInputCoreProps>(
  (
    {
      initialSerializedEditorState,
      replacementVersion = 0,
      onChange,
      onTextContentChange,
      onEnter,
      onFocus,
      autoFocus = false,
      disabled = false,
      className,
      contentClassName,
      onKeyDown,
      onEditorBackgroundMouseDown,

      mentionables,
      setMentionables,
      mentionDisplayMode = 'inline',
      onDeleteFromAll,
      displayMentionablesForDelete,

      enableSkills = true,
      selectedSkills = [],
      setSelectedSkills,

      enableAttachments = true,
      currentModel = null,

      mentionMenuMode,
      assistants,
      currentAssistantId,
      onSelectAssistant,
      currentChatMode,
      onSelectChatMode,
      allowAgentModeOption,
      models,
      skills,
      snippets,
      onCreateSnippetsFile,
      onRunSlashCommand,
      onMentionMenuToggle,
      mentionMenuPlacement,
      mentionMenuContainerRef,
    },
    ref,
  ) => {
    const app = useApp()
    const { t } = useLanguage()
    const { settings } = useSettings()
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

    const editorRef = useRef<LexicalEditor | null>(null)
    const contentEditableRef = useRef<HTMLDivElement>(null)
    const [isEditorReady, setIsEditorReady] = useState(false)
    const suppressedDestroyedMentionableKeysRef = useRef<Set<string>>(new Set())
    const suppressedDestroyedSkillNamesRef = useRef<Set<string>>(new Set())
    const appliedReplacementVersionRef = useRef(replacementVersion)

    const effectiveMentionables = useMemo(
      () => displayMentionablesForDelete ?? mentionables,
      [displayMentionablesForDelete, mentionables],
    )
    const inlineMentionables = useMemo(() => {
      if (mentionDisplayMode !== 'inline') {
        return [] as Mentionable[]
      }

      return [...mentionables]
    }, [mentionDisplayMode, mentionables])
    const effectiveSelectedSkills = useMemo(
      () => selectedSkills,
      [selectedSkills],
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
    const selectedSkillNames = useMemo(
      () => effectiveSelectedSkills.map((skill) => skill.name),
      [effectiveSelectedSkills],
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

    const handleSubmit = useCallback(() => {
      onEnter()
    }, [onEnter])

    const handleCreateImageMentionables = useCallback(
      (mentionableImages: MentionableImage[]) => {
        if (
          mentionableImages.length > 0 &&
          !chatModelSupportsVision(currentModel)
        ) {
          const modelLabel =
            currentModel?.name ?? currentModel?.model ?? 'model'
          const prefix = t(
            'chat.imageUnsupportedByModel',
            'This model does not accept image input. Enable "Vision" in the model settings to attach images.',
          )
          new Notice(`${prefix} (${modelLabel})`)
          return
        }
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
                    unitLabels: mentionableUnitLabels,
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
      },
      [currentModel, mentionableUnitLabels, mentionables, setMentionables, t],
    )

    const handleCreatePdfMentionables = useCallback(
      (mentionablePdfs: MentionablePDF[]) => {
        const newMentionablePdfs = mentionablePdfs.filter(
          (m) =>
            !mentionables.some(
              (mentionable) =>
                getMentionableKey(serializeMentionable(mentionable)) ===
                getMentionableKey(serializeMentionable(m)),
            ),
        )
        if (newMentionablePdfs.length === 0) return
        const editor = editorRef.current
        if (editor) {
          editor.update(() => {
            const nodesToInsert: LexicalNode[] = []
            newMentionablePdfs.forEach((mentionable) => {
              nodesToInsert.push(
                $createMentionNode(
                  getMentionableName(mentionable, {
                    unitLabels: mentionableUnitLabels,
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
        setMentionables([...mentionables, ...newMentionablePdfs])
      },
      [mentionableUnitLabels, mentionables, setMentionables],
    )

    const handleCreateOfficeMentionables = useCallback(
      (mentionableOffices: MentionableOffice[]) => {
        const newMentionableOffices = mentionableOffices.filter(
          (m) =>
            !mentionables.some(
              (mentionable) =>
                getMentionableKey(serializeMentionable(mentionable)) ===
                getMentionableKey(serializeMentionable(m)),
            ),
        )
        if (newMentionableOffices.length === 0) return
        const editor = editorRef.current
        if (editor) {
          editor.update(() => {
            const nodesToInsert: LexicalNode[] = []
            newMentionableOffices.forEach((mentionable) => {
              nodesToInsert.push(
                $createMentionNode(
                  getMentionableName(mentionable, {
                    unitLabels: mentionableUnitLabels,
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
        setMentionables([...mentionables, ...newMentionableOffices])
      },
      [mentionableUnitLabels, mentionables, setMentionables],
    )

    const handleCreateTextAttachmentMentionables = useCallback(
      (mentionableTextAttachments: MentionableTextAttachment[]) => {
        const newMentionables = mentionableTextAttachments.filter(
          (m) =>
            !mentionables.some(
              (mentionable) =>
                getMentionableKey(serializeMentionable(mentionable)) ===
                getMentionableKey(serializeMentionable(m)),
            ),
        )
        if (newMentionables.length === 0) return
        const editor = editorRef.current
        if (editor) {
          editor.update(() => {
            const nodesToInsert: LexicalNode[] = []
            newMentionables.forEach((mentionable) => {
              nodesToInsert.push(
                $createMentionNode(
                  getMentionableName(mentionable, {
                    unitLabels: mentionableUnitLabels,
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
        setMentionables([...mentionables, ...newMentionables])
      },
      [mentionableUnitLabels, mentionables, setMentionables],
    )

    const handleUploadFiles = useCallback(
      (files: File[]) => {
        if (!enableAttachments) return

        const {
          imageFiles,
          pdfFiles,
          officeFiles,
          textAttachmentFiles,
          unsupportedFiles,
        } = classifyUploadFiles(files)
        if (unsupportedFiles.length > 0) {
          new Notice(
            t(
              'chat.unsupportedFileType',
              'Unsupported file type: {names}',
            ).replace(
              '{names}',
              unsupportedFiles.map((file) => file.name).join(', '),
            ),
          )
        }
        if (imageFiles.length > 0) {
          void Promise.all(
            imageFiles.map((file) => fileToMentionableImage(file)),
          )
            .then((mentionableImages) => {
              handleCreateImageMentionables(mentionableImages)
            })
            .catch((error) => {
              console.error('Failed to process uploaded images', error)
              new Notice(
                t(
                  'chat.processImagesFailed',
                  'Failed to process uploaded images',
                ),
              )
            })
        }
        if (pdfFiles.length > 0) {
          void Promise.allSettled(
            pdfFiles.map((file) =>
              fileToMentionablePDF(app, file, { settings }),
            ),
          ).then((results) => {
            const successes: MentionablePDF[] = []
            results.forEach((result, idx) => {
              if (result.status === 'fulfilled') {
                successes.push(result.value)
              } else {
                const name = pdfFiles[idx]?.name ?? 'PDF'
                console.error(`Failed to extract PDF ${name}`, result.reason)
                new Notice(
                  t(
                    'chat.readPdfFailed',
                    'Failed to read PDF "{name}": {error}',
                  )
                    .replace('{name}', name)
                    .replace(
                      '{error}',
                      result.reason instanceof Error
                        ? result.reason.message
                        : 'unknown error',
                    ),
                )
              }
            })
            if (successes.length > 0) {
              handleCreatePdfMentionables(successes)
            }
          })
        }
        if (officeFiles.length > 0) {
          void Promise.allSettled(
            officeFiles.map((file) => fileToMentionableOffice(file)),
          ).then((results) => {
            const successes: MentionableOffice[] = []
            results.forEach((result, idx) => {
              if (result.status === 'fulfilled') {
                successes.push(result.value)
              } else {
                const name = officeFiles[idx]?.name ?? 'Office document'
                console.error(
                  `Failed to extract Office document ${name}`,
                  result.reason,
                )
                new Notice(
                  t(
                    'chat.readOfficeFailed',
                    'Failed to read Office document "{name}": {error}',
                  )
                    .replace('{name}', name)
                    .replace(
                      '{error}',
                      result.reason instanceof Error
                        ? result.reason.message
                        : 'unknown error',
                    ),
                )
              }
            })
            if (successes.length > 0) {
              handleCreateOfficeMentionables(successes)
            }
          })
        }
        if (textAttachmentFiles.length > 0) {
          void Promise.allSettled(
            textAttachmentFiles.map((file) =>
              fileToMentionableTextAttachment(file),
            ),
          ).then((results) => {
            const successes: MentionableTextAttachment[] = []
            results.forEach((result, idx) => {
              if (result.status === 'fulfilled') {
                successes.push(result.value)
              } else {
                const name = textAttachmentFiles[idx]?.name ?? 'text file'
                console.error(
                  `Failed to read text attachment ${name}`,
                  result.reason,
                )
                new Notice(
                  t(
                    'chat.readTextAttachmentFailed',
                    'Failed to read text file "{name}": {error}',
                  )
                    .replace('{name}', name)
                    .replace(
                      '{error}',
                      result.reason instanceof Error
                        ? result.reason.message
                        : 'unknown error',
                    ),
                )
              }
            })
            if (successes.length > 0) {
              handleCreateTextAttachmentMentionables(successes)
            }
          })
        }
      },
      [
        app,
        enableAttachments,
        handleCreateImageMentionables,
        handleCreateOfficeMentionables,
        handleCreatePdfMentionables,
        handleCreateTextAttachmentMentionables,
        settings,
        t,
      ],
    )

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          contentEditableRef.current?.focus()
        },
        focusEnd: () => {
          const editor = editorRef.current
          if (!editor) return
          contentEditableRef.current?.focus()
          editor.update(() => $getRoot().selectEnd(), { discrete: true })
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
        uploadFiles: (files: File[]) => {
          handleUploadFiles(files)
        },
      }),
      [handleSubmit, handleUploadFiles],
    )

    const handleMentionNodeMutation = useCallback(
      (mutations: NodeMutations<MentionNode>) => {
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
              suppressedDestroyedMentionableKeysRef.current.delete(
                mentionableKey,
              )
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
          new Notice(
            'Block reference pasted as text. Please reselect the block.',
          )
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
      },
      [
        app,
        effectiveMentionables,
        mentionables,
        onDeleteFromAll,
        setMentionables,
      ],
    )

    const handleSkillNodeMutation = useCallback(
      (mutations: NodeMutations<SkillNode>) => {
        if (!enableSkills || !setSelectedSkills) {
          return
        }

        const destroyedSkillNames: string[] = []
        const addedSkills: ChatSelectedSkill[] = []

        mutations.forEach((mutation) => {
          const skill = mutation.node.getSkill()
          if (mutation.mutation === 'destroyed') {
            if (suppressedDestroyedSkillNamesRef.current.has(skill.name)) {
              suppressedDestroyedSkillNamesRef.current.delete(skill.name)
              return
            }

            const nodeWithSameSkill = editorRef.current?.read(() =>
              $nodesOfType(SkillNode).find(
                (node) => node.getSkill().name === skill.name,
              ),
            )

            if (!nodeWithSameSkill) {
              destroyedSkillNames.push(skill.name)
            }
            return
          }

          if (
            effectiveSelectedSkills.some(
              (selectedSkill) => selectedSkill.name === skill.name,
            ) ||
            addedSkills.some(
              (selectedSkill) => selectedSkill.name === skill.name,
            )
          ) {
            return
          }

          addedSkills.push(skill)
        })

        if (destroyedSkillNames.length === 0 && addedSkills.length === 0) {
          return
        }

        setSelectedSkills(
          effectiveSelectedSkills
            .filter((skill) => !destroyedSkillNames.includes(skill.name))
            .concat(addedSkills),
        )
      },
      [effectiveSelectedSkills, enableSkills, setSelectedSkills],
    )

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
        contentEditableRef.current ===
        (contentEditableRef.current?.ownerDocument ?? document).activeElement

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
              unitLabels: mentionableUnitLabels,
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
      mentionableUnitLabels,
    ])

    useEffect(() => {
      if (!enableSkills) return

      const editor = editorRef.current
      if (!editor || !isEditorReady || !setSelectedSkills) return

      const skillsToMirror =
        mentionDisplayMode === 'inline' ? effectiveSelectedSkills : []
      const skillsByName = new Map(
        skillsToMirror.map((skill) => [skill.name, skill] as const),
      )

      const shouldMoveCursor =
        contentEditableRef.current ===
        (contentEditableRef.current?.ownerDocument ?? document).activeElement

      editor.update(() => {
        $nodesOfType(SkillNode).forEach((node) => {
          const skill = node.getSkill()
          if (skillsByName.has(skill.name)) return

          suppressedDestroyedSkillNamesRef.current.add(skill.name)
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

        const existingNames = new Set(
          $nodesOfType(SkillNode).map((node) => node.getSkill().name),
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
          if (existingNames.has(skill.name)) return

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
      enableSkills,
      isEditorReady,
      mentionDisplayMode,
      setSelectedSkills,
    ])

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

    const handleSelectSkill = useCallback(
      (skill: { name: string; description: string; path: string }) => {
        if (!enableSkills || !setSelectedSkills) {
          return
        }

        const nextSkill: ChatSelectedSkill = {
          name: skill.name,
          description: skill.description,
          path: skill.path,
        }

        if (
          effectiveSelectedSkills.some(
            (selectedSkill) => selectedSkill.name === nextSkill.name,
          )
        ) {
          return
        }

        setSelectedSkills([...effectiveSelectedSkills, nextSkill])
      },
      [effectiveSelectedSkills, enableSkills, setSelectedSkills],
    )

    const handleEditorBackgroundMouseDown = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        onEditorBackgroundMouseDown?.(event)

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
      [onEditorBackgroundMouseDown],
    )

    const initialEditorState = useMemo(() => {
      if (!initialSerializedEditorState) {
        return undefined
      }

      return (editor: LexicalEditor) => {
        try {
          editor.setEditorState(
            editor.parseEditorState(initialSerializedEditorState),
          )
        } catch (error) {
          // Defensive: a malformed serialized state shouldn't break the input box.
          console.warn(
            '[YOLO] Failed to restore chat input editor state',
            error,
          )
        }
      }
    }, [initialSerializedEditorState])

    useEffect(() => {
      if (appliedReplacementVersionRef.current === replacementVersion) {
        return
      }
      const editor = editorRef.current
      if (!editor || !isEditorReady) {
        return
      }
      appliedReplacementVersionRef.current = replacementVersion

      try {
        if (!initialSerializedEditorState) {
          editor.update(
            () => {
              const root = $getRoot()
              root.clear()
              root.append($createParagraphNode())
            },
            { discrete: true },
          )
          return
        }
        editor.setEditorState(
          editor.parseEditorState(initialSerializedEditorState),
        )
      } catch (error) {
        console.warn('[YOLO] Failed to replace chat input editor state', error)
      }
    }, [initialSerializedEditorState, isEditorReady, replacementVersion])

    const lexicalPlugins = useMemo(
      () => ({
        onEnter: {
          onVaultChat: handleSubmit,
        },
      }),
      [handleSubmit],
    )

    return (
      <div
        className={`yolo-message-input-core${className ? ` ${className}` : ''}${disabled ? ' is-disabled' : ''}`}
        onMouseDown={handleEditorBackgroundMouseDown}
      >
        <LexicalContentEditable
          initialEditorState={initialEditorState}
          editorRef={editorRef}
          contentEditableRef={contentEditableRef}
          onChange={onChange}
          onTextContentChange={onTextContentChange}
          onEnter={handleSubmit}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          onMentionNodeMutation={handleMentionNodeMutation}
          onSkillNodeMutation={
            enableSkills ? handleSkillNodeMutation : undefined
          }
          onCreateImageMentionables={
            enableAttachments ? handleCreateImageMentionables : undefined
          }
          onPasteFiles={enableAttachments ? handleUploadFiles : undefined}
          enableAttachments={enableAttachments}
          editable={!disabled}
          contentClassName={contentClassName}
          mentionDisplayMode={mentionDisplayMode}
          onSelectMentionable={handleSelectMentionableForBadge}
          mentionMenuMode={mentionMenuMode}
          assistants={assistants}
          currentAssistantId={currentAssistantId}
          onSelectAssistant={onSelectAssistant}
          currentChatMode={currentChatMode}
          onSelectChatMode={onSelectChatMode}
          allowAgentModeOption={allowAgentModeOption}
          models={models}
          selectedModelIds={selectedModelIds}
          skills={enableSkills ? skills : undefined}
          selectedSkillNames={enableSkills ? selectedSkillNames : undefined}
          onSelectSkill={enableSkills ? handleSelectSkill : undefined}
          onRunSlashCommand={onRunSlashCommand}
          snippets={snippets}
          onCreateSnippetsFile={onCreateSnippetsFile}
          onMentionMenuToggle={onMentionMenuToggle}
          mentionMenuPlacement={mentionMenuPlacement}
          mentionMenuContainerRef={mentionMenuContainerRef}
          autoFocus={autoFocus}
          plugins={lexicalPlugins}
        />
      </div>
    )
  },
)

MessageInputCore.displayName = 'MessageInputCore'

export default memo(MessageInputCore)
