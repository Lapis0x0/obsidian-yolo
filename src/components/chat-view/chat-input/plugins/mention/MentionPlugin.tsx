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
  Bot,
  Check,
  Cpu,
  FileIcon,
  FileText,
  FolderClosedIcon,
  MessageSquare,
} from 'lucide-react'
import { TFile } from 'obsidian'
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { JSX as ReactJSX } from 'react/jsx-runtime'

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
import { CHAT_MODES, type ChatMode } from '../../ChatModeSelect'
import { getMentionableIcon } from '../../utils/get-metionable-icon'
import { MenuOption, MenuTextMatch } from '../shared/LexicalMenu'
import {
  type RailMenuCategory,
  type RailMenuItemProps,
  RailMenuRow,
  useRailTypeaheadMenu,
} from '../shared/RailTypeaheadMenu'
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
// 过滤态里为助手/模式/模型保留的名额上限，见 flatOptions。
const NON_FILE_RESULT_QUOTA = 10

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
type MentionChatMode = ChatMode

type MentionTypeaheadOptionPayload =
  | {
      /**
       * 当前活动文件。它是叶子动作而不是类别，所以不进 rail，而是置顶在
       * 「文件」类别列表的第一行——@ 打开后回车即插入当前文件，仍是最短路径。
       */
      kind: 'current-file'
      label: string
      mentionable: Mentionable
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

    if (payload.kind === 'current-file') {
      const mentionable = payload.mentionable
      key = `current-file:${mentionable.type === 'file' ? mentionable.file.path : ''}`
      name = payload.label
      subtitle =
        mentionable.type === 'file'
          ? getDisplayFileName(mentionable.file.name)
          : null
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

function MentionsTypeaheadMenuItem(
  props: RailMenuItemProps<MentionTypeaheadOption>,
) {
  const { option } = props
  let iconNode: ReactNode = null

  if (option.payload.kind === 'current-file') {
    iconNode = <FileText size={15} className="yolo-rail-menu-row-icon" />
  } else if (option.payload.kind === 'assistant') {
    iconNode = renderAssistantIcon(
      option.payload.assistant.icon,
      15,
      'yolo-rail-menu-row-icon',
    )
  } else if (option.payload.kind === 'mode') {
    iconNode =
      option.payload.mode === 'agent' ? (
        <Bot size={15} className="yolo-rail-menu-row-icon" />
      ) : (
        <MessageSquare size={15} className="yolo-rail-menu-row-icon" />
      )
  } else {
    const Icon = getMentionableIcon(option.payload.mentionable)
    if (Icon) {
      iconNode = <Icon size={15} className="yolo-rail-menu-row-icon" />
    }
  }

  const isCurrent =
    ((option.payload.kind === 'assistant' || option.payload.kind === 'mode') &&
      option.payload.isCurrent) ||
    (option.payload.kind === 'mentionable' && option.payload.isSelected)

  return (
    <RailMenuRow
      {...props}
      icon={iconNode}
      name={option.name}
      description={option.subtitle}
      // @ 菜单的副文本是路径 / provider / 助手简介这类短 meta，排在标题同一行，
      // 文件列表才不会被撑成两倍高；`/` 菜单的整句描述则换行。
      inlineMeta
      trailing={
        isCurrent ? (
          <Check size={13} className="yolo-rail-menu-row-check" />
        ) : null
      }
    />
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
  const { t } = useLanguage()
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

  useEffect(() => {
    return () => {
      onMenuOpenChange?.(false)
    }
  }, [onMenuOpenChange])

  // 「当前文件」这一行的标题与图标要在菜单打开期间保持正确，所以活动文件是渲染
  // 期读取的状态，而不是只在选中那一刻才去 workspace 取。
  const [activeFile, setActiveFile] = useState<TFile | null>(() =>
    app.workspace.getActiveFile(),
  )
  useEffect(() => {
    const handleActiveLeafChange = () => {
      setActiveFile(app.workspace.getActiveFile())
    }
    app.workspace.on('active-leaf-change', handleActiveLeafChange)
    return () => {
      app.workspace.off('active-leaf-change', handleActiveLeafChange)
    }
  }, [app])

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

  const matchesModelQuery = useCallback(
    (model: MentionableModel, query: string) => {
      const providerId = model.providerId ?? ''
      const providerLabel = providerLabelById.get(providerId) ?? providerId
      return (
        model.name.toLowerCase().includes(query) ||
        model.modelId.toLowerCase().includes(query) ||
        providerId.toLowerCase().includes(query) ||
        providerLabel.toLowerCase().includes(query)
      )
    },
    [providerLabelById],
  )

  const toModelOption = useCallback(
    (mentionable: MentionableModel) =>
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
    [providerLabelById, selectedModelIds],
  )

  const toAssistantOption = useCallback(
    (assistant: Assistant) =>
      new MentionTypeaheadOption({
        kind: 'assistant',
        assistant,
        isCurrent: assistant.id === currentAssistantId,
      }),
    [currentAssistantId],
  )

  const chatModeEntries = useMemo(() => {
    if (!onSelectChatMode) return []
    const modeKeys: MentionChatMode[] = allowAgentModeOption
      ? [...CHAT_MODES]
      : ['ask']
    return modeKeys.map((mode) => ({
      mode,
      label:
        mode === 'agent'
          ? t('chatMode.agent', 'Agent')
          : t('chatMode.ask', 'Ask'),
      subtitle:
        mode === 'agent'
          ? t('chatMode.agentDesc', 'Enable tool calling capabilities')
          : t('chatMode.askDesc', 'Ask, refine, create'),
    }))
  }, [allowAgentModeOption, onSelectChatMode, t])

  const toModeOption = useCallback(
    (entry: { mode: MentionChatMode; label: string; subtitle: string }) =>
      new MentionTypeaheadOption({
        kind: 'mode',
        mode: entry.mode,
        label: entry.label,
        subtitle: entry.subtitle,
        isCurrent: entry.mode === (currentChatMode ?? 'ask'),
      }),
    [currentChatMode],
  )

  const checkForSlashTriggerMatch = useBasicTypeaheadTriggerMatch('/', {
    minLength: 0,
  })

  // queryString === null 即菜单未打开：此时不要去跑 vault 级的文件/文件夹扫描。
  const isRootBrowse =
    menuMode === 'entry' && queryString !== null && !normalizedQuery

  /**
   * 根态各类别的条目。文件/文件夹都按 SUGGESTION_LIST_LENGTH_LIMIT 截断——根态
   * 是「浏览最近/靠前的若干条」，真正要定位某个文件靠的是直接打字搜索（过滤态
   * 覆盖文件、文件夹、助手、模式、模型全部五类）。
   */
  const currentFileOption = useMemo(() => {
    if (!isRootBrowse || !activeFile) return null
    return new MentionTypeaheadOption({
      kind: 'current-file',
      label: t('chat.mentionMenu.entryCurrentFile', '当前文件'),
      mentionable: { type: 'file', file: activeFile },
    })
  }, [activeFile, isRootBrowse, t])

  const fileCategoryOptions = useMemo(() => {
    if (!isRootBrowse) return []
    const fileOptions = results
      .filter(
        (result): result is SearchableMentionable & { type: 'file' } =>
          result.type === 'file',
      )
      .slice(0, SUGGESTION_LIST_LENGTH_LIMIT)
      .map(
        (mentionable) =>
          new MentionTypeaheadOption({
            kind: 'mentionable',
            mentionable,
            subtitle: getFileParentFolderPath(mentionable.file.path),
          }),
      )
    return currentFileOption ? [currentFileOption, ...fileOptions] : fileOptions
  }, [currentFileOption, isRootBrowse, results])

  const folderCategoryOptions = useMemo(() => {
    if (!isRootBrowse) return []
    const folders = searchFoldersByQuery
      ? searchFoldersByQuery('')
      : results.filter(
          (result): result is MentionableFolder => result.type === 'folder',
        )
    return folders.slice(0, SUGGESTION_LIST_LENGTH_LIMIT).map(
      (mentionable) =>
        new MentionTypeaheadOption({
          kind: 'mentionable',
          mentionable,
          subtitle: `/${mentionable.folder.path}`,
        }),
    )
  }, [isRootBrowse, results, searchFoldersByQuery])

  const categories = useMemo<RailMenuCategory<MentionTypeaheadOption>[]>(() => {
    if (menuMode !== 'entry') return []
    const entries: RailMenuCategory<MentionTypeaheadOption>[] = [
      {
        key: 'file',
        label: t('chat.mentionMenu.entryFile', '文件'),
        icon: <FileIcon size={13} className="yolo-rail-menu-rail-item-icon" />,
        options: fileCategoryOptions,
      },
      {
        key: 'folder',
        label: t('chat.mentionMenu.entryFolder', '文件夹'),
        icon: (
          <FolderClosedIcon
            size={13}
            className="yolo-rail-menu-rail-item-icon"
          />
        ),
        options: folderCategoryOptions,
      },
    ]
    if (chatModeEntries.length > 0) {
      entries.push({
        key: 'mode',
        label: t('chat.mentionMenu.entryMode', '模式'),
        icon: (
          <MessageSquare size={13} className="yolo-rail-menu-rail-item-icon" />
        ),
        options: chatModeEntries.map(toModeOption),
        count: chatModeEntries.length,
      })
    }
    if (assistants.length > 0) {
      entries.push({
        key: 'assistant',
        label: t('chat.mentionMenu.entryAssistant', '助手'),
        icon: <Bot size={13} className="yolo-rail-menu-rail-item-icon" />,
        options: assistants.map(toAssistantOption),
        count: assistants.length,
      })
    }
    if (modelMentionables.length > 0) {
      entries.push({
        key: 'model',
        label: t('chat.mentionMenu.entryModel', '模型'),
        icon: <Cpu size={13} className="yolo-rail-menu-rail-item-icon" />,
        options: modelMentionables.map(toModelOption),
        count: modelMentionables.length,
      })
    }
    return entries
  }, [
    assistants,
    chatModeEntries,
    fileCategoryOptions,
    folderCategoryOptions,
    menuMode,
    modelMentionables,
    t,
    toAssistantOption,
    toModeOption,
    toModelOption,
  ])

  /**
   * 过滤态的扁平列表。类别内搜索已取消，所以这里必须覆盖 rail 上的全部五类，
   * 否则某些条目将没有任何可达路径。
   */
  const flatOptions = useMemo<MentionTypeaheadOption[] | null>(() => {
    if (queryString == null) return []

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

    if (!normalizedQuery) return null

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
      .map(toAssistantOption)

    const modeOptions = chatModeEntries
      .filter(
        (entry) =>
          entry.label.toLowerCase().includes(normalizedQuery) ||
          entry.subtitle.toLowerCase().includes(normalizedQuery),
      )
      .map(toModeOption)

    const modelOptions = modelMentionables
      .filter((model) => matchesModelQuery(model, normalizedQuery))
      .map(toModelOption)

    // 文件/文件夹的模糊搜索几乎总能塞满整个列表，直接拼接会把助手/模式/模型
    // 挤出去——类别内搜索取消后，过滤态是它们唯一的可达路径，所以先给它们留
    // 出配额，剩下的名额才归文件。
    const others = [...assistantOptions, ...modeOptions, ...modelOptions]
    const reserved = Math.min(others.length, NON_FILE_RESULT_QUOTA)
    return [
      ...searchableMentionables.slice(
        0,
        SUGGESTION_LIST_LENGTH_LIMIT - reserved,
      ),
      ...others,
    ].slice(0, SUGGESTION_LIST_LENGTH_LIMIT)
  }, [
    assistants,
    chatModeEntries,
    matchesModelQuery,
    menuMode,
    modelMentionables,
    normalizedQuery,
    queryString,
    results,
    toAssistantOption,
    toModeOption,
    toModelOption,
  ])

  const railMenu = useRailTypeaheadMenu({
    categories,
    flatOptions,
    placement,
  })

  const options = railMenu.displayOptions

  const onSelectOption = useCallback(
    (
      selectedOption: MentionTypeaheadOption,
      nodeToReplace: TextNode | null,
      closeMenu: () => void,
    ) => {
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

      const mentionable = selectedOption.payload.mentionable

      if (mentionDisplayMode === 'badge') {
        if (nodeToReplace) {
          const emptyNode = $createTextNode('')
          nodeToReplace.replace(emptyNode)
          emptyNode.select()
        }
        onSelectMentionable?.(mentionable)
        closeMenu()
        return
      }

      const mentionNode = $createMentionNode(
        getMentionableName(mentionable, {
          unitLabels: mentionableUnitLabels,
        }),
        serializeMentionable(mentionable),
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
      mentionableUnitLabels,
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

  const emptyLabel = t('chat.mentionMenu.categoryEmpty', '暂无内容')

  return (
    <LexicalTypeaheadMenuPlugin<MentionTypeaheadOption>
      onQueryChange={setQueryString}
      onSelectOption={onSelectOption}
      triggerFn={checkForMentionMatch}
      options={options}
      commandPriority={COMMAND_PRIORITY_NORMAL}
      onOpen={() => onMenuOpenChange?.(true)}
      onClose={() => {
        onMenuOpenChange?.(false)
        railMenu.reset()
      }}
      customKeyHandlers={railMenu.customKeyHandlers}
      menuRenderFn={(anchorElementRef, itemProps) =>
        railMenu.renderMenu({
          anchorElementRef,
          itemProps,
          menuContainer: menuContainerRef?.current,
          emptyLabel,
          renderItem: (props) => (
            <MentionsTypeaheadMenuItem
              {...props}
              key={`${props.id}:${props.option.key}`}
            />
          ),
        })
      }
    />
  )
}
