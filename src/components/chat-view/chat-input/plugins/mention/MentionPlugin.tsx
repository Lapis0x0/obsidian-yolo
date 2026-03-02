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
import { ArrowLeft, Bot, Check, FileIcon, FolderClosedIcon } from 'lucide-react'
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

import { useLanguage } from '../../../../../contexts/language-context'
import { Assistant } from '../../../../../types/assistant.types'
import { Mentionable } from '../../../../../types/mentionable'
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

type MentionMenuMode = 'direct-search' | 'entry'
type MentionMenuScope = 'root' | 'assistant' | 'file' | 'folder'
type MentionEntryOptionType = 'assistant' | 'file' | 'folder'

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
      kind: 'mentionable'
      mentionable: Mentionable
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
    } else {
      const mentionable = payload.mentionable
      switch (mentionable.type) {
        case 'file':
          key = mentionable.file.path
          name = mentionable.file.name
          subtitle = null
          break
        case 'folder':
          key = mentionable.folder.path
          name = mentionable.folder.name
          subtitle = null
          break
        case 'vault':
          key = 'vault'
          name = 'Vault'
          subtitle = null
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
  const isAssistantOption = option.payload.kind === 'assistant'

  if (option.payload.kind === 'back') {
    iconNode = (
      <ArrowLeft size={14} className="smtcmp-smart-space-mention-option-icon" />
    )
  } else if (option.payload.kind === 'entry') {
    if (option.payload.entryType === 'assistant') {
      iconNode = (
        <Bot size={14} className="smtcmp-smart-space-mention-option-icon" />
      )
    } else if (option.payload.entryType === 'file') {
      iconNode = (
        <FileIcon
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
          isAssistantOption
            ? ' smtcmp-smart-space-mention-option-text--assistant'
            : ''
        }`}
      >
        <div className="smtcmp-smart-space-mention-option-name">
          {option.name}
        </div>
        {option.subtitle && (
          <div
            className={`smtcmp-smart-space-mention-option-path${
              isAssistantOption
                ? ' smtcmp-smart-space-mention-option-assistant-description'
                : ''
            }`}
          >
            {option.subtitle}
          </div>
        )}
      </div>
      {option.payload.kind === 'assistant' && option.payload.isCurrent && (
        <Check size={12} className="smtcmp-smart-space-mention-option-check" />
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
}): ReactJSX.Element | null {
  const [editor] = useLexicalComposerContext()

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

  const results = useMemo(() => {
    if (queryString == null) return []
    return searchResultByQuery(queryString)
  }, [queryString, searchResultByQuery])

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
      const entryOptions: Array<{
        entryType: MentionEntryOptionType
        label: string
      }> = [
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
      return entryOptions
        .filter((entry) => {
          if (!normalizedQuery) return true
          return entry.label.toLowerCase().includes(normalizedQuery)
        })
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

    const mentionables = results.filter((result) => {
      if (menuScope === 'file') return result.type === 'file'
      if (menuScope === 'folder') return result.type === 'folder'
      return false
    })

    const mentionableOptions = mentionables.map(
      (mentionable) =>
        new MentionTypeaheadOption({
          kind: 'mentionable',
          mentionable,
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
    menuMode,
    menuScope,
    normalizedQuery,
    queryString,
    results,
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
        const nextScope: MentionMenuScope =
          selectedOption.payload.entryType === 'assistant'
            ? 'assistant'
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
      mentionDisplayMode,
      mentionableUnitLabel,
      onSelectAssistant,
      onSelectMentionable,
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

  return (
    <LexicalTypeaheadMenuPlugin<MentionTypeaheadOption>
      onQueryChange={setQueryString}
      onSelectOption={onSelectOption}
      triggerFn={checkForMentionMatch}
      options={options}
      commandPriority={COMMAND_PRIORITY_NORMAL}
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
