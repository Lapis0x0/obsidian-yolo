/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license.
 * Original source: https://github.com/facebook/lexical
 *
 * Modified from the original code
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createTextNode, COMMAND_PRIORITY_NORMAL, TextNode } from 'lexical'
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Cpu,
  FileIcon,
  FileText,
  FolderClosedIcon,
  Infinity as InfinityIcon,
  MessageSquare,
} from 'lucide-react'
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { JSX as ReactJSX } from 'react/jsx-runtime'
import { createPortal } from 'react-dom'

import { PROVIDER_PRESET_INFO } from '../../../../../constants'
import { useApp } from '../../../../../contexts/app-context'
import { useLanguage } from '../../../../../contexts/language-context'
import { useSettings } from '../../../../../contexts/settings-context'
import { Assistant } from '../../../../../types/assistant.types'
import { ChatModel } from '../../../../../types/chat-model.types'
import {
  Mentionable,
  MentionableFolder,
  MentionableModel,
} from '../../../../../types/mentionable'
import { renderAssistantIcon } from '../../../../../utils/assistant-icon'
import {
  getMentionableName,
  serializeMentionable,
} from '../../../../../utils/chat/mentionable'
import { SearchableMentionable } from '../../../../../utils/fuzzy-search'
import { getMentionableIcon } from '../../utils/get-metionable-icon'
import { MenuOption, MenuTextMatch } from '../shared/LexicalMenu'
import {
  LexicalTypeaheadMenuPlugin,
  useBasicTypeaheadTriggerMatch,
} from '../typeahead-menu/LexicalTypeaheadMenuPlugin'

import { $createMentionNode } from './MentionNode'

const PUNCTUATION =
  '\\.,\\+\\*\\?\\$\\@\\|#{}\\(\\)\\^\\-\\[\\]\\\\/!%\'"~=<>_:;'
const NAME = '\\b[A-Z][^\\s' + PUNCTUATION + ']'

const DocumentMentionsRegex = {
  NAME,
  PUNCTUATION,
}

const PUNC = DocumentMentionsRegex.PUNCTUATION

const TRIGGERS = ['@'].join('')

// Chars we expect to see in a mention (non-space, non-punctuation).
const VALID_CHARS = '[^' + TRIGGERS + PUNC + '\\s]'

// Non-standard series of chars. Each series must be preceded and followed by
// a valid char.
const VALID_JOINS =
  '(?:' +
  '\\.[ |$]|' + // E.g. "r. " in "Mr. Smith"
  ' |' + // E.g. " " in "Josh Duck"
  '[' +
  PUNC +
  ']|' + // E.g. "-' in "Salier-Hellendag"
  ')'

const LENGTH_LIMIT = 75

const AtSignMentionsRegex = new RegExp(
  `(^|\\s|\\()([${TRIGGERS}]((?:${VALID_CHARS}${VALID_JOINS}){0,${LENGTH_LIMIT}}))$`,
)

// 50 is the longest alias length limit.
const ALIAS_LENGTH_LIMIT = 50

// Regex used to match alias.
const AtSignMentionsRegexAliasRegex = new RegExp(
  `(^|\\s|\\()([${TRIGGERS}]((?:${VALID_CHARS}){0,${ALIAS_LENGTH_LIMIT}}))$`,
)

// At most, 20 suggestions are shown in the popup.
const SUGGESTION_LIST_LENGTH_LIMIT = 20

function getDisplayFileName(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name
}

function getFileParentFolderPath(filePath: string): string {
  const lastSlashIndex = filePath.lastIndexOf('/')
  if (lastSlashIndex <= 0) {
    return '/'
  }
  return `/${filePath.slice(0, lastSlashIndex)}`
}

type MentionMenuMode = 'direct-search' | 'entry'
type MentionMenuScope =
  | 'root'
  | 'assistant'
  | 'file'
  | 'folder'
  | 'mode'
  | 'model'
type MentionEntryOptionType =
  | 'current-file'
  | 'assistant'
  | 'file'
  | 'folder'
  | 'mode'
  | 'model'
type MentionChatMode = 'chat' | 'agent'

type MentionTypeaheadOptionPayload =
  | {
      kind: 'back'
      label: string
    }
  | {
      kind: 'entry'
      entryType: MentionEntryOptionType
      label: string
      subtitle?: string
    }
  | {
      kind: 'assistant'
      assistant: Assistant
      isCurrent: boolean
    }
  | {
      kind: 'mode'
      mode: MentionChatMode
      label: string
      subtitle?: string
      isCurrent: boolean
    }
  | {
      kind: 'mentionable'
      mentionable: Mentionable
      subtitle?: string
      isSelected?: boolean
    }

function checkForAtSignMentions(
  text: string,
  minMatchLength: number,
): MenuTextMatch | null {
  let match = AtSignMentionsRegex.exec(text)

  if (match === null) {
    match = AtSignMentionsRegexAliasRegex.exec(text)
  }
  if (match !== null) {
    // The strategy ignores leading whitespace but we need to know it's
    // length to add it to the leadOffset
    const maybeLeadingWhitespace = match[1]

    const matchingString = match[3]
    if (matchingString.length >= minMatchLength) {
      return {
        leadOffset: match.index + maybeLeadingWhitespace.length,
        matchingString,
        replaceableString: match[2],
      }
    }
  }
  return null
}

function getPossibleQueryMatch(text: string): MenuTextMatch | null {
  return checkForAtSignMentions(text, 0)
}

class MentionTypeaheadOption extends MenuOption {
  name: string
  subtitle: string | null
  payload: MentionTypeaheadOptionPayload

  constructor(payload: MentionTypeaheadOptionPayload) {
    let key = 'unknown'
    let name = ''
    let subtitle: string | null = null

    if (payload.kind === 'back') {
      key = 'entry:back'
      name = payload.label
      subtitle = null
    } else if (payload.kind === 'entry') {
      key = `entry:${payload.entryType}`
      name = payload.label
      subtitle = payload.subtitle ?? null
    } else if (payload.kind === 'assistant') {
      key = `assistant:${payload.assistant.id}`
      name = payload.assistant.name
      subtitle = payload.assistant.description ?? null
    } else if (payload.kind === 'mode') {
      key = `mode:${payload.mode}`
      name = payload.label
      subtitle = payload.subtitle ?? null
    } else {
      const mentionable = payload.mentionable
      switch (mentionable.type) {
        case 'file':
          key = mentionable.file.path
          name = getDisplayFileName(mentionable.file.name)
          subtitle = payload.subtitle ?? null
          break
        case 'folder':
          key = mentionable.folder.path
          name = mentionable.folder.name
          subtitle = payload.subtitle ?? null
          break
        case 'vault':
          key = 'vault'
          name = 'Vault'
          subtitle = null
          break
        case 'model':
          key = `model:${mentionable.modelId}`
          name = mentionable.name
          subtitle = payload.subtitle ?? mentionable.providerId ?? null
          break
        default:
          key = 'unknown'
          name = ''
          subtitle = null
          break
      }
    }

    super(key)
    this.name = name
    this.subtitle = subtitle
    this.payload = payload
  }
}

function MentionsTypeaheadMenuItem({
  index,
  isSelected,
  onClick,
  onMouseEnter,
  option,
}: {
  index: number
  isSelected: boolean
  onClick: () => void
  onMouseEnter: () => void
  option: MentionTypeaheadOption
}) {
  let iconNode: ReactNode = null
  const isInlineMetaOption =
    option.payload.kind === 'assistant' ||
    option.payload.kind === 'mode' ||
    (option.payload.kind === 'mentionable' &&
      (option.payload.mentionable.type === 'model' ||
        option.payload.mentionable.type === 'folder' ||
        option.payload.mentionable.type === 'file') &&
      Boolean(option.subtitle))

  if (option.payload.kind === 'back') {
    iconNode = (
      <ArrowLeft size={14} className="smtcmp-smart-space-mention-option-icon" />
    )
  } else if (option.payload.kind === 'entry') {
    if (option.payload.entryType === 'assistant') {
      iconNode = (
        <Bot size={14} className="smtcmp-smart-space-mention-option-icon" />
      )
    } else if (option.payload.entryType === 'mode') {
      iconNode = (
        <MessageSquare
          size={14}
          className="smtcmp-smart-space-mention-option-icon"
        />
      )
    } else if (option.payload.entryType === 'model') {
      iconNode = (
        <Cpu size={14} className="smtcmp-smart-space-mention-option-icon" />
      )
    } else if (option.payload.entryType === 'file') {
      iconNode = (
        <FileIcon
          size={14}
          className="smtcmp-smart-space-mention-option-icon"
        />
      )
    } else if (option.payload.entryType === 'current-file') {
      iconNode = (
        <FileText
          size={14}
          className="smtcmp-smart-space-mention-option-icon"
        />
      )
    } else {
      iconNode = (
        <FolderClosedIcon
          size={14}
          className="smtcmp-smart-space-mention-option-icon"
        />
      )
    }
  } else if (option.payload.kind === 'assistant') {
    iconNode = renderAssistantIcon(
      option.payload.assistant.icon,
      14,
      'smtcmp-smart-space-mention-option-icon',
    )
  } else if (option.payload.kind === 'mode') {
    iconNode =
      option.payload.mode === 'agent' ? (
        <InfinityIcon
          size={14}
          className="smtcmp-smart-space-mention-option-icon"
        />
      ) : (
        <MessageSquare
          size={14}
          className="smtcmp-smart-space-mention-option-icon"
        />
      )
  } else {
    const Icon = getMentionableIcon(option.payload.mentionable)
    if (Icon) {
      iconNode = (
        <Icon size={14} className="smtcmp-smart-space-mention-option-icon" />
      )
    }
  }

  return (
    <button
      type="button"
      className={`smtcmp-popover-item smtcmp-smart-space-mention-option ${
        isSelected ? 'active' : ''
      }`}
      ref={(el) => option.setRefElement(el)}
      role="option"
      aria-selected={isSelected}
      id={`typeahead-item-${index}`}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      data-highlighted={isSelected ? 'true' : undefined}
    >
      {iconNode}
      <div
        className={`smtcmp-smart-space-mention-option-text${
          isInlineMetaOption
            ? ' smtcmp-smart-space-mention-option-text--inline-meta'
            : ''
        }`}
      >
        <div className="smtcmp-smart-space-mention-option-name">
          {option.name}
        </div>
        {option.subtitle && (
          <div
            className={`smtcmp-smart-space-mention-option-path${
              isInlineMetaOption
                ? ' smtcmp-smart-space-mention-option-inline-meta'
                : ''
            }`}
          >
            {option.subtitle}
          </div>
        )}
      </div>
      {((option.payload.kind === 'assistant' ||
        option.payload.kind === 'mode') &&
        option.payload.isCurrent) ||
      (option.payload.kind === 'mentionable' && option.payload.isSelected) ? (
        <Check size={12} className="smtcmp-smart-space-mention-option-check" />
      ) : null}
      {option.payload.kind === 'entry' && (
        <ChevronRight
          size={14}
          className="smtcmp-smart-space-mention-option-expand"
        />
      )}
    </button>
  )
}

export default function NewMentionsPlugin({
  searchResultByQuery,
  onMenuOpenChange,
  menuContainerRef,
  placement = 'top',
  mentionDisplayMode = 'inline',
  onSelectMentionable,
  menuMode = 'direct-search',
  assistants = [],
  currentAssistantId,
  onSelectAssistant,
  currentChatMode,
  onSelectChatMode,
  allowAgentModeOption = true,
  models = [],
  selectedModelIds = [],
  searchFoldersByQuery,
}: {
  searchResultByQuery: (query: string) => SearchableMentionable[]
  onMenuOpenChange?: (isOpen: boolean) => void
  menuContainerRef?: RefObject<HTMLElement>
  placement?: 'top' | 'bottom'
  mentionDisplayMode?: 'inline' | 'badge'
  onSelectMentionable?: (mentionable: Mentionable) => void
  menuMode?: MentionMenuMode
  assistants?: Assistant[]
  currentAssistantId?: string
  onSelectAssistant?: (assistantId: string) => void
  currentChatMode?: MentionChatMode
  onSelectChatMode?: (mode: MentionChatMode) => void
  allowAgentModeOption?: boolean
  models?: ChatModel[]
  selectedModelIds?: string[]
  searchFoldersByQuery?: (query: string) => MentionableFolder[]
}): ReactJSX.Element | null {
  const [editor] = useLexicalComposerContext()
  const app = useApp()
  const { settings } = useSettings()

  const [queryString, setQueryString] = useState<string | null>(null)
  const [menuScope, setMenuScope] = useState<MentionMenuScope>('root')
  const { t } = useLanguage()
  const mentionableUnitLabel = useMemo(
    () => t('common.characters', 'chars'),
    [t],
  )

  useEffect(() => {
    return () => {
      onMenuOpenChange?.(false)
    }
  }, [onMenuOpenChange])

  useEffect(() => {
    if (queryString === null) {
      setMenuScope('root')
    }
  }, [queryString])

  const normalizedQuery = useMemo(
    () => (queryString ?? '').trim().toLowerCase(),
    [queryString],
  )

  const providerLabelById = useMemo(
    () =>
      new Map(
        settings.providers.map((provider) => [
          provider.id,
          PROVIDER_PRESET_INFO[provider.presetType]?.label ?? provider.id,
        ]),
      ),
    [settings.providers],
  )

  const results = useMemo(() => {
    if (queryString == null) return []
    return searchResultByQuery(queryString)
  }, [queryString, searchResultByQuery])

  const folderResults = useMemo(() => {
    if (queryString == null || !searchFoldersByQuery) {
      return [] as MentionableFolder[]
    }
    return searchFoldersByQuery(queryString)
  }, [queryString, searchFoldersByQuery])
  const modelMentionables = useMemo<MentionableModel[]>(
    () =>
      models.map((model) => ({
        type: 'model',
        modelId: model.id,
        name: model.name?.trim() || model.model || model.id,
        providerId: model.providerId,
      })),
    [models],
  )
  const filteredModelMentionables = useMemo(() => {
    if (!normalizedQuery) {
      return modelMentionables
    }

    return modelMentionables.filter((model) => {
      const providerId = model.providerId ?? ''
      const providerLabel = providerLabelById.get(providerId) ?? providerId
      return (
        model.name.toLowerCase().includes(normalizedQuery) ||
        model.modelId.toLowerCase().includes(normalizedQuery) ||
        providerId.toLowerCase().includes(normalizedQuery) ||
        providerLabel.toLowerCase().includes(normalizedQuery)
      )
    })
  }, [modelMentionables, normalizedQuery, providerLabelById])

  const checkForSlashTriggerMatch = useBasicTypeaheadTriggerMatch('/', {
    minLength: 0,
  })

  const options = useMemo(() => {
    if (queryString == null) {
      return [] as MentionTypeaheadOption[]
    }

    if (menuMode === 'direct-search') {
      return results
        .map(
          (result) =>
            new MentionTypeaheadOption({
              kind: 'mentionable',
              mentionable: result,
            }),
        )
        .slice(0, SUGGESTION_LIST_LENGTH_LIMIT)
    }

    if (menuScope === 'root') {
      if (normalizedQuery) {
        const searchableMentionables = results
          .filter(
            (
              result,
            ): result is SearchableMentionable & { type: 'file' | 'folder' } =>
              result.type === 'file' || result.type === 'folder',
          )
          .map(
            (mentionable) =>
              new MentionTypeaheadOption({
                kind: 'mentionable',
                mentionable,
                subtitle:
                  mentionable.type === 'file'
                    ? getFileParentFolderPath(mentionable.file.path)
                    : `/${mentionable.folder.path}`,
              }),
          )

        const assistantOptions = assistants
          .filter((assistant) => {
            const description = assistant.description ?? ''
            return (
              assistant.name.toLowerCase().includes(normalizedQuery) ||
              description.toLowerCase().includes(normalizedQuery)
            )
          })
          .map(
            (assistant) =>
              new MentionTypeaheadOption({
                kind: 'assistant',
                assistant,
                isCurrent: assistant.id === currentAssistantId,
              }),
          )

        const modelOptions = filteredModelMentionables.map(
          (mentionable) =>
            new MentionTypeaheadOption({
              kind: 'mentionable',
              mentionable,
              subtitle:
                mentionable.providerId != null
                  ? (providerLabelById.get(mentionable.providerId) ??
                    mentionable.providerId)
                  : undefined,
              isSelected: selectedModelIds.includes(mentionable.modelId),
            }),
        )

        return [
          ...searchableMentionables,
          ...assistantOptions,
          ...modelOptions,
        ].slice(0, SUGGESTION_LIST_LENGTH_LIMIT)
      }

      const entryOptions: Array<{
        entryType: MentionEntryOptionType
        label: string
      }> = [
        {
          entryType: 'current-file',
          label: t('chat.mentionMenu.entryCurrentFile', '当前文件'),
        },
        {
          entryType: 'assistant',
          label: t('chat.mentionMenu.entryAssistant', '助手'),
        },
        {
          entryType: 'file',
          label: t('chat.mentionMenu.entryFile', '文件'),
        },
        {
          entryType: 'folder',
          label: t('chat.mentionMenu.entryFolder', '文件夹'),
        },
      ]
      if (onSelectChatMode) {
        entryOptions.splice(1, 0, {
          entryType: 'mode',
          label: t('chat.mentionMenu.entryMode', '模式'),
        })
      }
      entryOptions.push({
        entryType: 'model',
        label: t('chat.mentionMenu.entryModel', '模型'),
      })
      return entryOptions
        .map(
          (entry) =>
            new MentionTypeaheadOption({
              kind: 'entry',
              entryType: entry.entryType,
              label: entry.label,
            }),
        )
        .slice(0, SUGGESTION_LIST_LENGTH_LIMIT)
    }

    if (menuScope === 'mode') {
      const modeOptions: MentionChatMode[] = allowAgentModeOption
        ? ['chat', 'agent']
        : ['chat']
      const modeTypeaheadOptions = modeOptions
        .map((mode) => {
          const label =
            mode === 'agent'
              ? t('chatMode.agent', 'Agent')
              : t('chatMode.chat', 'Chat')
          const subtitle =
            mode === 'agent'
              ? t('chatMode.agentDesc', 'Enable tool calling capabilities')
              : t('chatMode.chatDesc', 'Normal conversation mode')
          return {
            mode,
            label,
            subtitle,
          }
        })
        .filter((option) => {
          if (!normalizedQuery) return true
          return (
            option.label.toLowerCase().includes(normalizedQuery) ||
            option.subtitle.toLowerCase().includes(normalizedQuery)
          )
        })
        .map(
          (option) =>
            new MentionTypeaheadOption({
              kind: 'mode',
              mode: option.mode,
              label: option.label,
              subtitle: option.subtitle,
              isCurrent: option.mode === (currentChatMode ?? 'chat'),
            }),
        )

      return [
        new MentionTypeaheadOption({
          kind: 'back',
          label: t('chat.mentionMenu.back', '返回上一级'),
        }),
        ...modeTypeaheadOptions,
      ].slice(0, SUGGESTION_LIST_LENGTH_LIMIT)
    }

    if (menuScope === 'assistant') {
      const assistantOptions = assistants
        .filter((assistant) => {
          if (!normalizedQuery) return true
          const description = assistant.description ?? ''
          return (
            assistant.name.toLowerCase().includes(normalizedQuery) ||
            description.toLowerCase().includes(normalizedQuery)
          )
        })
        .map(
          (assistant) =>
            new MentionTypeaheadOption({
              kind: 'assistant',
              assistant,
              isCurrent: assistant.id === currentAssistantId,
            }),
        )
      return [
        new MentionTypeaheadOption({
          kind: 'back',
          label: t('chat.mentionMenu.back', '返回上一级'),
        }),
        ...assistantOptions,
      ].slice(0, SUGGESTION_LIST_LENGTH_LIMIT)
    }

    if (menuScope === 'model') {
      const modelOptions = filteredModelMentionables.map(
        (mentionable) =>
          new MentionTypeaheadOption({
            kind: 'mentionable',
            mentionable,
            subtitle:
              mentionable.providerId != null
                ? (providerLabelById.get(mentionable.providerId) ??
                  mentionable.providerId)
                : undefined,
            isSelected: selectedModelIds.includes(mentionable.modelId),
          }),
      )
      return [
        new MentionTypeaheadOption({
          kind: 'back',
          label: t('chat.mentionMenu.back', '返回上一级'),
        }),
        ...modelOptions,
      ].slice(0, SUGGESTION_LIST_LENGTH_LIMIT)
    }

    if (menuScope === 'folder') {
      const folderMentionables = searchFoldersByQuery
        ? folderResults
        : results.filter(
            (result): result is MentionableFolder => result.type === 'folder',
          )
      const mentionableOptions = folderMentionables.map(
        (mentionable) =>
          new MentionTypeaheadOption({
            kind: 'mentionable',
            mentionable,
            subtitle: `/${mentionable.folder.path}`,
          }),
      )
      return [
        new MentionTypeaheadOption({
          kind: 'back',
          label: t('chat.mentionMenu.back', '返回上一级'),
        }),
        ...mentionableOptions,
      ]
    }

    const mentionables = results.filter(
      (result): result is SearchableMentionable & { type: 'file' } =>
        result.type === 'file',
    )

    const mentionableOptions = mentionables.map(
      (mentionable) =>
        new MentionTypeaheadOption({
          kind: 'mentionable',
          mentionable,
          subtitle: getFileParentFolderPath(mentionable.file.path),
        }),
    )
    return [
      new MentionTypeaheadOption({
        kind: 'back',
        label: t('chat.mentionMenu.back', '返回上一级'),
      }),
      ...mentionableOptions,
    ].slice(0, SUGGESTION_LIST_LENGTH_LIMIT)
  }, [
    assistants,
    currentAssistantId,
    currentChatMode,
    folderResults,
    allowAgentModeOption,
    filteredModelMentionables,
    menuMode,
    menuScope,
    onSelectChatMode,
    normalizedQuery,
    providerLabelById,
    queryString,
    results,
    searchFoldersByQuery,
    selectedModelIds,
    t,
  ])

  const onSelectOption = useCallback(
    (
      selectedOption: MentionTypeaheadOption,
      nodeToReplace: TextNode | null,
      closeMenu: () => void,
    ) => {
      if (selectedOption.payload.kind === 'back') {
        if (nodeToReplace) {
          const triggerNode = $createTextNode('@')
          nodeToReplace.replace(triggerNode)
          triggerNode.selectEnd()
        }
        setMenuScope('root')
        return
      }

      if (selectedOption.payload.kind === 'entry') {
        if (selectedOption.payload.entryType === 'current-file') {
          const activeFile = app.workspace.getActiveFile()
          if (!activeFile) {
            closeMenu()
            return
          }
          const currentFileMentionable: Mentionable = {
            type: 'file',
            file: activeFile,
          }

          if (mentionDisplayMode === 'badge') {
            if (nodeToReplace) {
              const emptyNode = $createTextNode('')
              nodeToReplace.replace(emptyNode)
              emptyNode.select()
            }
            onSelectMentionable?.(currentFileMentionable)
            closeMenu()
            return
          }

          const mentionNode = $createMentionNode(
            getMentionableName(currentFileMentionable, {
              unitLabel: mentionableUnitLabel,
              currentFileLabel: t(
                'chat.mentionMenu.entryCurrentFile',
                '当前文件',
              ),
            }),
            serializeMentionable(currentFileMentionable),
          )
          if (nodeToReplace) {
            nodeToReplace.replace(mentionNode)
          }
          const spaceNode = $createTextNode(' ')
          mentionNode.insertAfter(spaceNode)
          spaceNode.select()
          closeMenu()
          return
        }

        const nextScope: MentionMenuScope =
          selectedOption.payload.entryType === 'assistant'
            ? 'assistant'
            : selectedOption.payload.entryType === 'mode'
              ? 'mode'
              : selectedOption.payload.entryType === 'model'
                ? 'model'
                : selectedOption.payload.entryType === 'file'
                  ? 'file'
                  : 'folder'
        if (nodeToReplace) {
          const triggerNode = $createTextNode('@')
          nodeToReplace.replace(triggerNode)
          triggerNode.selectEnd()
        }
        setMenuScope(nextScope)
        return
      }

      if (selectedOption.payload.kind === 'assistant') {
        if (nodeToReplace) {
          const emptyNode = $createTextNode('')
          nodeToReplace.replace(emptyNode)
          emptyNode.select()
        }
        onSelectAssistant?.(selectedOption.payload.assistant.id)
        closeMenu()
        return
      }

      if (selectedOption.payload.kind === 'mode') {
        if (nodeToReplace) {
          const emptyNode = $createTextNode('')
          nodeToReplace.replace(emptyNode)
          emptyNode.select()
        }
        onSelectChatMode?.(selectedOption.payload.mode)
        closeMenu()
        return
      }

      if (mentionDisplayMode === 'badge') {
        if (nodeToReplace) {
          const emptyNode = $createTextNode('')
          nodeToReplace.replace(emptyNode)
          emptyNode.select()
        }
        onSelectMentionable?.(selectedOption.payload.mentionable)
        closeMenu()
        return
      }

      const mentionNode = $createMentionNode(
        getMentionableName(selectedOption.payload.mentionable, {
          unitLabel: mentionableUnitLabel,
        }),
        serializeMentionable(selectedOption.payload.mentionable),
      )
      if (nodeToReplace) {
        nodeToReplace.replace(mentionNode)
      }

      const spaceNode = $createTextNode(' ')
      mentionNode.insertAfter(spaceNode)

      spaceNode.select()
      closeMenu()
    },
    [
      app,
      mentionDisplayMode,
      mentionableUnitLabel,
      onSelectAssistant,
      onSelectChatMode,
      onSelectMentionable,
      t,
    ],
  )

  const checkForMentionMatch = useCallback(
    (text: string) => {
      const slashMatch = checkForSlashTriggerMatch(text, editor)

      if (slashMatch !== null) {
        return null
      }
      return getPossibleQueryMatch(text)
    },
    [checkForSlashTriggerMatch, editor],
  )

  const getDefaultHighlightedIndex = useCallback(
    (menuOptions: MentionTypeaheadOption[]) => {
      if (menuScope === 'root' || menuMode !== 'entry') {
        return 0
      }
      const firstOption = menuOptions[0]
      if (firstOption?.payload.kind === 'back' && menuOptions.length > 1) {
        return 1
      }
      return 0
    },
    [menuMode, menuScope],
  )

  return (
    <LexicalTypeaheadMenuPlugin<MentionTypeaheadOption>
      onQueryChange={setQueryString}
      onSelectOption={onSelectOption}
      triggerFn={checkForMentionMatch}
      options={options}
      commandPriority={COMMAND_PRIORITY_NORMAL}
      getDefaultHighlightedIndex={getDefaultHighlightedIndex}
      onOpen={() => onMenuOpenChange?.(true)}
      onClose={() => onMenuOpenChange?.(false)}
      menuRenderFn={(
        anchorElementRef,
        { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex },
      ) =>
        anchorElementRef.current && options.length
          ? createPortal(
              <div
                className="smtcmp-smart-space-mention-popover"
                data-placement={placement}
              >
                <div className="smtcmp-popover smtcmp-smart-space-popover smtcmp-smart-space-mention-dropdown">
                  <div
                    className="smtcmp-smart-space-mention-list"
                    role="listbox"
                  >
                    {options.map((option, i: number) => (
                      <MentionsTypeaheadMenuItem
                        index={i}
                        isSelected={selectedIndex === i}
                        onClick={() => {
                          setHighlightedIndex(i)
                          selectOptionAndCleanUp(option)
                        }}
                        onMouseEnter={() => {
                          setHighlightedIndex(i)
                        }}
                        key={option.key}
                        option={option}
                      />
                    ))}
                  </div>
                </div>
              </div>,
              menuContainerRef?.current ?? anchorElementRef.current,
            )
          : null
      }
    />
  )
}
