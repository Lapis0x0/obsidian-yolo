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
  useLayoutEffect,
  useMemo,
  useRef,
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
import { CHAT_MODES, type ChatMode } from '../../ChatModeSelect'
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
type MentionChatMode = ChatMode
type MentionMenuTransitionDirection = 'none' | 'forward' | 'back'

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
  onMouseEnter: (event: React.MouseEvent<HTMLElement>) => void
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
      <ArrowLeft size={14} className="yolo-smart-space-mention-option-icon" />
    )
  } else if (option.payload.kind === 'entry') {
    if (option.payload.entryType === 'assistant') {
      iconNode = (
        <Bot size={14} className="yolo-smart-space-mention-option-icon" />
      )
    } else if (option.payload.entryType === 'mode') {
      iconNode = (
        <MessageSquare
          size={14}
          className="yolo-smart-space-mention-option-icon"
        />
      )
    } else if (option.payload.entryType === 'model') {
      iconNode = (
        <Cpu size={14} className="yolo-smart-space-mention-option-icon" />
      )
    } else if (option.payload.entryType === 'file') {
      iconNode = (
        <FileIcon size={14} className="yolo-smart-space-mention-option-icon" />
      )
    } else if (option.payload.entryType === 'current-file') {
      iconNode = (
        <FileText size={14} className="yolo-smart-space-mention-option-icon" />
      )
    } else {
      iconNode = (
        <FolderClosedIcon
          size={14}
          className="yolo-smart-space-mention-option-icon"
        />
      )
    }
  } else if (option.payload.kind === 'assistant') {
    iconNode = renderAssistantIcon(
      option.payload.assistant.icon,
      14,
      'yolo-smart-space-mention-option-icon',
    )
  } else if (option.payload.kind === 'mode') {
    iconNode =
      option.payload.mode === 'agent-full' ? (
        <InfinityIcon
          size={14}
          className="yolo-smart-space-mention-option-icon"
        />
      ) : option.payload.mode === 'agent' ? (
        <Bot size={14} className="yolo-smart-space-mention-option-icon" />
      ) : (
        <MessageSquare
          size={14}
          className="yolo-smart-space-mention-option-icon"
        />
      )
  } else {
    const Icon = getMentionableIcon(option.payload.mentionable)
    if (Icon) {
      iconNode = (
        <Icon size={14} className="yolo-smart-space-mention-option-icon" />
      )
    }
  }

  return (
    <button
      type="button"
      className={`yolo-popover-item yolo-smart-space-mention-option ${
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
        className={`yolo-smart-space-mention-option-text${
          isInlineMetaOption
            ? ' yolo-smart-space-mention-option-text--inline-meta'
            : ''
        }`}
      >
        <div className="yolo-smart-space-mention-option-name">
          {option.name}
        </div>
        {option.subtitle && (
          <div
            className={`yolo-smart-space-mention-option-path${
              isInlineMetaOption
                ? ' yolo-smart-space-mention-option-inline-meta'
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
        <Check size={12} className="yolo-smart-space-mention-option-check" />
      ) : null}
      {option.payload.kind === 'entry' && (
        <ChevronRight
          size={14}
          className="yolo-smart-space-mention-option-expand"
        />
      )}
    </button>
  )
}

/**
 * 把 LexicalMenu 内部维护的 selectedIndex 同步到外层 state，让
 * customKeyHandlers / 子面板派生逻辑可以根据主面板键盘高亮项决定预览。
 * 用独立组件包住 useEffect，避免在 menuRenderFn render path 里 setState 触发死循环。
 */
function MainSelectedIndexSync({
  selectedIndex,
  setMainSelectedIndex,
}: {
  selectedIndex: number | null
  setMainSelectedIndex: (index: number | null) => void
}): null {
  useEffect(() => {
    setMainSelectedIndex(selectedIndex)
  }, [selectedIndex, setMainSelectedIndex])
  return null
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
  const [menuContentTransition, setMenuContentTransition] = useState<{
    direction: MentionMenuTransitionDirection
    nonce: number
  }>({ direction: 'none', nonce: 0 })
  // Hover/方向键预览 子面板相关状态（只在 menuScope === 'root' 且非搜索/direct-search 下生效）。
  // - hoveredEntry: 鼠标当前 hover 的一级 entry，由 ~100ms open timer 写入。
  // - focusSide: 键盘焦点所在面板（'main' = 默认主面板，'sub' = 已 → 进入子面板）。
  // - subHighlightedIndex: 子面板键盘高亮项索引。
  // - previewEntry 派生：hover 优先；否则取主面板当前高亮的 entry（如果是 entry 类型）。
  const [hoveredEntry, setHoveredEntry] =
    useState<MentionEntryOptionType | null>(null)
  const [focusSide, setFocusSide] = useState<'main' | 'sub'>('main')
  const [subHighlightedIndex, setSubHighlightedIndex] = useState(0)
  // 主面板当前键盘高亮 index。menuRenderFn 里能拿到 selectedIndex，
  // 但 customKeyHandlers 与子面板派生在 render 外侧的闭包里 —— 通过状态把它
  // 同步出来，用作"键盘高亮主面板时驱动子面板预览"的数据源。
  const [mainSelectedIndex, setMainSelectedIndex] = useState<number | null>(
    null,
  )
  // 共享同一个 close timer：主面板 leave 启动它、子面板 enter 取消它，
  // 让"主+子面板视为一个 hover 区域"，鼠标横向穿越 gap 时不会触发关闭。
  const closeTimerRef = useRef<number | null>(null)
  const openTimerRef = useRef<number | null>(null)
  // 子面板 DOM 容器引用，用于测量 viewport 空间并决定 flip。
  const subPanelRef = useRef<HTMLDivElement | null>(null)
  const mainPanelRef = useRef<HTMLDivElement | null>(null)
  // popover 根容器（position:relative），作为子面板 absolute 定位的参考；
  // 也用来挂载 --yolo-sub-anchor-top / --yolo-sub-anchor-bottom CSS 变量。
  const popoverRef = useRef<HTMLDivElement | null>(null)
  // 'right' = 默认右侧；'left' = 空间不够时翻到左侧；'hidden' = 两侧都不够，不渲染。
  const [subSide, setSubSide] = useState<'right' | 'left' | 'hidden'>('right')
  const { t } = useLanguage()
  const mentionableUnitLabels = useMemo(
    () => ({
      characters: t('common.characters', 'chars'),
      words: t('common.words', 'words'),
      wordsCharacters: t('common.wordsCharacters', 'words/chars'),
    }),
    [t],
  )

  useEffect(() => {
    return () => {
      onMenuOpenChange?.(false)
    }
  }, [onMenuOpenChange])

  const clearHoverTimers = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
  }, [])

  const resetSubPreviewState = useCallback(() => {
    clearHoverTimers()
    setHoveredEntry(null)
    setFocusSide('main')
    setSubHighlightedIndex(0)
    setMainSelectedIndex(null)
  }, [clearHoverTimers])

  const animateMenuContent = useCallback(
    (direction: MentionMenuTransitionDirection) => {
      setMenuContentTransition((prev) => ({
        direction,
        nonce: prev.nonce + 1,
      }))
    },
    [],
  )

  useEffect(() => {
    if (queryString === null) {
      setMenuScope('root')
      resetSubPreviewState()
    }
  }, [queryString, resetSubPreviewState])

  // 卸载时兜底清理 timer，避免 React 警告或在已卸载组件上 setState。
  useEffect(() => {
    return () => {
      clearHoverTimers()
    }
  }, [clearHoverTimers])

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

  /**
   * 根据一级 entry 类型构建对应的二级 option 列表（不含"返回上一级"）。
   * 此函数被两条路径复用：
   * 1) drill-down：用户点击 entry，setMenuScope('xxx')，主面板被替换为
   *    [back, ...subOptions]
   * 2) hover/键盘预览：右侧子面板独立渲染，直接使用本函数返回的列表
   * 这样两条路径生成的 option 完全一致，避免行为漂移。 */
  const getSubOptionsForEntry = useCallback(
    (
      entryType: MentionEntryOptionType,
      subQuery: string,
    ): MentionTypeaheadOption[] => {
      const lowerQuery = subQuery.trim().toLowerCase()

      if (entryType === 'mode') {
        const modeOptions: MentionChatMode[] = allowAgentModeOption
          ? [...CHAT_MODES]
          : ['ask']
        return modeOptions
          .map((mode) => {
            const label =
              mode === 'agent-full'
                ? t('chatMode.agentFull', 'Agent (Full Access)')
                : mode === 'agent'
                  ? t('chatMode.agent', 'Agent')
                  : t('chatMode.ask', 'Ask')
            const subtitle =
              mode === 'agent-full'
                ? t('chatMode.agentFullDesc', 'Auto-approve all tool calls')
                : mode === 'agent'
                  ? t('chatMode.agentDesc', 'Enable tool calling capabilities')
                  : t('chatMode.askDesc', 'Ask, refine, create')
            return { mode, label, subtitle }
          })
          .filter((option) => {
            if (!lowerQuery) return true
            return (
              option.label.toLowerCase().includes(lowerQuery) ||
              option.subtitle.toLowerCase().includes(lowerQuery)
            )
          })
          .map(
            (option) =>
              new MentionTypeaheadOption({
                kind: 'mode',
                mode: option.mode,
                label: option.label,
                subtitle: option.subtitle,
                isCurrent: option.mode === (currentChatMode ?? 'ask'),
              }),
          )
      }

      if (entryType === 'assistant') {
        return assistants
          .filter((assistant) => {
            if (!lowerQuery) return true
            const description = assistant.description ?? ''
            return (
              assistant.name.toLowerCase().includes(lowerQuery) ||
              description.toLowerCase().includes(lowerQuery)
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
      }

      if (entryType === 'model') {
        const filtered = lowerQuery
          ? modelMentionables.filter((model) => {
              const providerId = model.providerId ?? ''
              const providerLabel =
                providerLabelById.get(providerId) ?? providerId
              return (
                model.name.toLowerCase().includes(lowerQuery) ||
                model.modelId.toLowerCase().includes(lowerQuery) ||
                providerId.toLowerCase().includes(lowerQuery) ||
                providerLabel.toLowerCase().includes(lowerQuery)
              )
            })
          : modelMentionables
        return filtered.map(
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
      }

      if (entryType === 'folder') {
        // 优先用 searchFoldersByQuery（覆盖全 vault folder 树）；
        // 未提供时回退到 results 里 folder 类型的 fallback（与重构前一致），
        // drill-down 与 hover 预览复用同一路径，保证数据一致。
        const folderMentionables: MentionableFolder[] = searchFoldersByQuery
          ? searchFoldersByQuery(subQuery)
          : results.filter(
              (result): result is MentionableFolder => result.type === 'folder',
            )
        return folderMentionables.map(
          (mentionable) =>
            new MentionTypeaheadOption({
              kind: 'mentionable',
              mentionable,
              subtitle: `/${mentionable.folder.path}`,
            }),
        )
      }

      if (entryType === 'file') {
        const fileResults = searchResultByQuery(subQuery).filter(
          (result): result is SearchableMentionable & { type: 'file' } =>
            result.type === 'file',
        )
        return fileResults.map(
          (mentionable) =>
            new MentionTypeaheadOption({
              kind: 'mentionable',
              mentionable,
              subtitle: getFileParentFolderPath(mentionable.file.path),
            }),
        )
      }

      // 'current-file' 是 leaf，不应该到这里。
      return []
    },
    [
      allowAgentModeOption,
      assistants,
      currentAssistantId,
      currentChatMode,
      modelMentionables,
      providerLabelById,
      results,
      searchFoldersByQuery,
      searchResultByQuery,
      selectedModelIds,
      t,
    ],
  )

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

    // drill-down 二级面板：复用 getSubOptionsForEntry 保持与 hover 预览一致。
    const scopeEntryMap: Record<
      Exclude<MentionMenuScope, 'root'>,
      MentionEntryOptionType
    > = {
      mode: 'mode',
      assistant: 'assistant',
      model: 'model',
      folder: 'folder',
      file: 'file',
    }
    const entryType = scopeEntryMap[menuScope]
    const subOptions = getSubOptionsForEntry(entryType, queryString ?? '')
    const backOption = new MentionTypeaheadOption({
      kind: 'back',
      label: t('chat.mentionMenu.back', '返回上一级'),
    })
    // folder scope 原实现没有 slice 上限，这里保留差异以避免行为变更。
    if (menuScope === 'folder') {
      return [backOption, ...subOptions]
    }
    return [backOption, ...subOptions].slice(0, SUGGESTION_LIST_LENGTH_LIMIT)
  }, [
    assistants,
    currentAssistantId,
    filteredModelMentionables,
    getSubOptionsForEntry,
    menuMode,
    menuScope,
    onSelectChatMode,
    normalizedQuery,
    providerLabelById,
    queryString,
    results,
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
        animateMenuContent('back')
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
              unitLabels: mentionableUnitLabels,
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
        animateMenuContent('forward')
        setMenuScope(nextScope)
        // drill-down 后子面板的语义被主面板顶掉，必须清空 hover 预览状态。
        resetSubPreviewState()
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
          unitLabels: mentionableUnitLabels,
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
      animateMenuContent,
      app,
      mentionDisplayMode,
      mentionableUnitLabels,
      onSelectAssistant,
      onSelectChatMode,
      onSelectMentionable,
      resetSubPreviewState,
      t,
    ],
  )

  // 派生当前预览的 entry：搜索/direct-search/已经 drill-down 之后都不预览。
  // 否则 hover 优先；hover 未生效时（纯键盘场景）取主面板当前 selectedIndex 对应的
  // entry option，让 ↑↓ 移动主面板时子面板跟随刷新。
  const shouldRenderSubpanel =
    !normalizedQuery && menuMode !== 'direct-search' && menuScope === 'root'
  let previewEntry: MentionEntryOptionType | null = null
  if (shouldRenderSubpanel) {
    if (hoveredEntry !== null) {
      previewEntry = hoveredEntry
    } else if (mainSelectedIndex !== null) {
      const candidate = options[mainSelectedIndex]
      if (candidate && candidate.payload.kind === 'entry') {
        previewEntry = candidate.payload.entryType
      }
    }
  }
  // leaf entry 不出子面板。
  const previewEntryEffective =
    previewEntry && previewEntry !== 'current-file' ? previewEntry : null
  const subOptions = useMemo(
    () =>
      previewEntryEffective
        ? getSubOptionsForEntry(previewEntryEffective, '').slice(
            0,
            SUGGESTION_LIST_LENGTH_LIMIT,
          )
        : ([] as MentionTypeaheadOption[]),
    [getSubOptionsForEntry, previewEntryEffective],
  )

  // 子面板可见时才进入键盘子面板焦点；从 sub → main 后或子面板消失时，回 main。
  useEffect(() => {
    if (subOptions.length === 0 || !previewEntryEffective) {
      if (focusSide === 'sub') setFocusSide('main')
      if (subHighlightedIndex !== 0) setSubHighlightedIndex(0)
    } else if (subHighlightedIndex >= subOptions.length) {
      setSubHighlightedIndex(0)
    }
  }, [subOptions.length, previewEntryEffective, focusSide, subHighlightedIndex])

  // flip 测量：每次子面板出现/主面板尺寸变化/视口尺寸变化时重新计算。
  // 所需宽度与 popover.css 中 .yolo-smart-space-mention-subpanel 的实际规则保持一致：
  //   width: min(480px, calc(100vw - 24px))
  // 先限制在 LexicalMenu 写入的 Chat 容器边界内；侧边栏 Chat 不跨 pane 展开。
  // 两侧都不够则 hidden，由组件兜底回退到 drill-down。
  useLayoutEffect(() => {
    if (!previewEntryEffective || subOptions.length === 0) return
    const main = mainPanelRef.current
    if (!main) return
    const win = main.ownerDocument?.defaultView ?? window
    // 解析 CSS 变量 --yolo-chat-typeahead-max-width；仅支持 px 数值，其他单位/解析失败时
    // 回退到 480，与 popover.css 中的默认值保持一致。
    const parseMaxWidthPx = (raw: string): number => {
      const trimmed = raw.trim()
      if (!trimmed) return 480
      const match = /^(-?\d+(?:\.\d+)?)px$/.exec(trimmed)
      if (!match) return 480
      const value = Number.parseFloat(match[1])
      return Number.isFinite(value) && value > 0 ? value : 480
    }
    const parseOptionalPx = (raw: string): number | null => {
      const trimmed = raw.trim()
      const match = /^(-?\d+(?:\.\d+)?)px$/.exec(trimmed)
      if (!match) return null
      const value = Number.parseFloat(match[1])
      return Number.isFinite(value) ? value : null
    }
    const measure = () => {
      const mainRect = main.getBoundingClientRect()
      const viewportWidth = win.innerWidth
      const gap = 6
      const style = win.getComputedStyle(main)
      // 与 CSS min(var(--yolo-chat-typeahead-max-width, 480px), 100vw - 24px) 同步。
      const maxWidthPx = parseMaxWidthPx(
        style.getPropertyValue('--yolo-chat-typeahead-max-width'),
      )
      const requiredWidth = Math.min(
        maxWidthPx,
        Math.max(0, viewportWidth - 24),
      )
      const boundaryLeft =
        parseOptionalPx(
          style.getPropertyValue('--yolo-typeahead-boundary-left'),
        ) ?? 0
      const boundaryRight =
        parseOptionalPx(
          style.getPropertyValue('--yolo-typeahead-boundary-right'),
        ) ?? viewportWidth
      const effectiveLeft = Math.max(0, boundaryLeft)
      const effectiveRight = Math.min(viewportWidth, boundaryRight)
      const spaceRight = effectiveRight - mainRect.right - gap
      const spaceLeft = mainRect.left - effectiveLeft - gap
      if (spaceRight >= requiredWidth) {
        setSubSide('right')
      } else if (spaceLeft >= requiredWidth) {
        setSubSide('left')
      } else {
        setSubSide('hidden')
      }
    }
    measure()
    win.addEventListener('resize', measure)
    return () => {
      win.removeEventListener('resize', measure)
    }
  }, [previewEntryEffective, subOptions.length, hoveredEntry])

  // 子面板锚点测量：把当前预览 entry 项相对 popover 容器的 top/bottom 写成 CSS 变量，
  // 子面板用 placement(top/bottom) 决定底对齐(top placement, 向上展开) 或顶对齐(bottom placement, 向下展开)。
  // 业内做法：子菜单与主菜单同向展开。我们 placement='top' 时主菜单向上开，子菜单也向上 → 底对齐 hover 项。
  const previewAnchorIndex = useMemo(() => {
    if (!previewEntryEffective) return -1
    return options.findIndex(
      (o) =>
        o.payload.kind === 'entry' &&
        o.payload.entryType === previewEntryEffective,
    )
  }, [options, previewEntryEffective])

  useLayoutEffect(() => {
    const popover = popoverRef.current
    const main = mainPanelRef.current
    if (!popover || !main) return
    if (
      previewAnchorIndex < 0 ||
      subOptions.length === 0 ||
      subSide === 'hidden'
    )
      return
    const items = main.querySelectorAll<HTMLElement>('[role="option"]')
    const item = items[previewAnchorIndex]
    if (!item) return
    const popoverRect = popover.getBoundingClientRect()
    const itemRect = item.getBoundingClientRect()
    const top = Math.round(itemRect.top - popoverRect.top)
    const bottom = Math.round(itemRect.bottom - popoverRect.top)
    popover.setCssProps({
      '--yolo-sub-anchor-top': `${top}px`,
      '--yolo-sub-anchor-bottom': `${bottom}px`,
    })
  }, [previewAnchorIndex, subOptions.length, subSide, placement])

  // 子面板项的选中：复用 onSelectOption 的下游逻辑（mode / assistant / mentionable）。
  // 但这条路径没有 `nodeToReplace` 概念 —— 子面板项不是来自主面板的 selectOptionAndCleanUp。
  // 解决：调用 selectOptionAndCleanUp（由 LexicalMenu 注入）传入子面板的 option。
  // LexicalMenu 会负责 split text node + 调用我们传入的 onSelectOption，从而生成与 drill-down
  // 完全一致的 mention node / badge。

  // 子面板 Enter / 点击的选中走 selectOptionAndCleanUp（由 LexicalMenu 的 menuRenderFn
  // 提供）。但 customKeyHandlers 是声明在 LexicalTypeaheadMenuPlugin 级别的，跟
  // menuRenderFn 不在同一个闭包里。用 ref 把最新的 selectOptionAndCleanUp 暴露出来。
  const selectOptionAndCleanUpRef = useRef<
    ((option: MentionTypeaheadOption) => void) | null
  >(null)
  // 同上：把 setHighlightedIndex 暴露给顶层 effect，hoveredEntry 切换时同步主面板高亮。
  const setHighlightedIndexRef = useRef<((index: number) => void) | null>(null)

  // hover open/close 助手
  const HOVER_OPEN_MS = 100
  const HOVER_CLOSE_MS = 150
  const cancelHoverOpen = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
  }, [])
  const scheduleHoverOpen = useCallback(
    (entryType: MentionEntryOptionType, delayMs: number = HOVER_OPEN_MS) => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      cancelHoverOpen()
      openTimerRef.current = window.setTimeout(() => {
        openTimerRef.current = null
        setHoveredEntry(entryType)
      }, delayMs)
    },
    [cancelHoverOpen],
  )
  const scheduleHoverClose = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
    }
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setHoveredEntry(null)
      setFocusSide('main')
    }, HOVER_CLOSE_MS)
  }, [])
  const cancelHoverClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

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

  // 子面板键盘高亮项 scrollIntoView，避免长列表下高亮项滚出可视区域。
  useEffect(() => {
    if (focusSide !== 'sub') return
    const option = subOptions[subHighlightedIndex]
    const el = option?.ref?.current
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [focusSide, subHighlightedIndex, subOptions])

  // 切换预览的 entry 时，重置子面板滚动到顶部，避免上一个长列表的 scrollTop 残留。
  useEffect(() => {
    if (subPanelRef.current) {
      subPanelRef.current.scrollTop = 0
    }
  }, [previewEntryEffective])

  // 子面板可见且非 hidden 时才接管键盘。IME 合成中一律放行（中文输入正常）。
  const subPanelActive =
    shouldRenderSubpanel &&
    previewEntryEffective !== null &&
    subOptions.length > 0 &&
    subSide !== 'hidden'

  // Safe triangle：鼠标从当前 hover 项斜向移动到子面板时，会经过其他主菜单项；
  // 用三角形（hover 项的"靠子面板"边中点 + 子面板"靠主面板"那一侧的 top/bottom 两端）
  // 判定鼠标当前是否在"前往子面板"的路径上；在三角形内时，其他 entry 的 hover 不触发预览切换。
  // 鼠标在 anchor 项触发 hover 时记录的位置；作为三角形的顶点 A。
  // 当 hoveredEntry 切换时重置（见下方 effect）。
  const anchorCursorPosRef = useRef<{ x: number; y: number } | null>(null)
  const lastCursorPosRef = useRef<{ x: number; y: number } | null>(null)
  // 同步 ref 状态到 React state，让 popover 的 data-safe-active 属性更新驱动 CSS 抑制 :hover。
  const [safeActive, setSafeActive] = useState(false)

  // hoveredEntry 切换时把上一帧鼠标位置作为新三角形的顶点 A
  // （等价于"用户进入 anchor 时的位置"，floating-ui safePolygon 的做法）。
  // 同时把主面板高亮同步到新 entry 对应的 index（buffer commit 后视觉跟上）。
  // 用 useLayoutEffect 避免视觉残留一帧。
  useLayoutEffect(() => {
    if (hoveredEntry !== null && lastCursorPosRef.current) {
      anchorCursorPosRef.current = { ...lastCursorPosRef.current }
    } else if (hoveredEntry === null) {
      anchorCursorPosRef.current = null
      setSafeActive(false)
    }
    if (hoveredEntry !== null && setHighlightedIndexRef.current) {
      const idx = options.findIndex(
        (o) =>
          o.payload.kind === 'entry' && o.payload.entryType === hoveredEntry,
      )
      if (idx >= 0) setHighlightedIndexRef.current(idx)
    }
  }, [hoveredEntry, options])

  // 抽出来的 safe triangle 判定 —— 让 mousemove 和 mouseenter 共用，
  // 避免事件时序导致 mouseenter 看到旧的 safe 状态。
  const updateSafeTriangle = useCallback(
    (px: number, py: number): boolean => {
      if (!subPanelActive || !subPanelRef.current) {
        return false
      }
      const anchor = anchorCursorPosRef.current
      if (!anchor) {
        return false
      }
      const subRect = subPanelRef.current.getBoundingClientRect()
      const ax = anchor.x
      const ay = anchor.y
      const bx = subSide === 'right' ? subRect.left : subRect.right
      const by = subRect.top
      const cx = bx
      const cy = subRect.bottom
      const sign = (
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        x3: number,
        y3: number,
      ) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3)
      const d1 = sign(px, py, ax, ay, bx, by)
      const d2 = sign(px, py, bx, by, cx, cy)
      const d3 = sign(px, py, cx, cy, ax, ay)
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0
      return !(hasNeg && hasPos)
    },
    [subPanelActive, subSide],
  )

  const handlePopoverMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      lastCursorPosRef.current = { x: event.clientX, y: event.clientY }
      const active = updateSafeTriangle(event.clientX, event.clientY)
      if (active) {
        cancelHoverOpen()
      }
      setSafeActive(active)
    },
    [cancelHoverOpen, updateSafeTriangle],
  )

  const customKeyHandlers = useMemo(
    () => ({
      onArrowRight: (event: KeyboardEvent): boolean => {
        if (event.isComposing) return false
        if (focusSide === 'main' && subPanelActive) {
          setFocusSide('sub')
          // 永远从语义上的第一项开始 —— 子菜单内容物理上始终是 list 顺序从上到下排，
          // 不管整体向上还是向下展开。第一项就是用户预期的"第一个"（参考 macOS 菜单行为）。
          setSubHighlightedIndex(0)
          return true
        }
        return false
      },
      onArrowLeft: (event: KeyboardEvent): boolean => {
        if (event.isComposing) return false
        if (focusSide === 'sub') {
          setFocusSide('main')
          return true
        }
        return false
      },
      onArrowDown: (event: KeyboardEvent): boolean => {
        if (event.isComposing) return false
        if (focusSide === 'sub' && subOptions.length > 0) {
          setSubHighlightedIndex((prev) => (prev + 1) % subOptions.length)
          return true
        }
        return false
      },
      onArrowUp: (event: KeyboardEvent): boolean => {
        if (event.isComposing) return false
        if (focusSide === 'sub' && subOptions.length > 0) {
          setSubHighlightedIndex((prev) =>
            prev === 0 ? subOptions.length - 1 : prev - 1,
          )
          return true
        }
        return false
      },
      onEnter: (event: KeyboardEvent | null): boolean => {
        if (event?.isComposing) return false
        if (focusSide === 'sub' && subOptions.length > 0) {
          const option = subOptions[subHighlightedIndex]
          const select = selectOptionAndCleanUpRef.current
          if (option && select) {
            select(option)
            return true
          }
        }
        return false
      },
    }),
    [focusSide, subOptions, subPanelActive, subHighlightedIndex],
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
      onClose={() => {
        onMenuOpenChange?.(false)
        resetSubPreviewState()
      }}
      customKeyHandlers={customKeyHandlers}
      menuRenderFn={(
        anchorElementRef,
        { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex },
      ) => {
        // 每次 render 同步最新的 selectOptionAndCleanUp 到 ref，供 customKeyHandlers 使用。
        selectOptionAndCleanUpRef.current = selectOptionAndCleanUp
        setHighlightedIndexRef.current = setHighlightedIndex
        if (!anchorElementRef.current || !options.length) return null
        const showSubpanel = subPanelActive
        return createPortal(
          <div
            ref={popoverRef}
            className="yolo-smart-space-mention-popover"
            data-placement={placement}
            data-safe-active={safeActive ? 'true' : undefined}
            onPointerLeave={() => scheduleHoverClose()}
            onPointerEnter={() => cancelHoverClose()}
            onMouseMove={handlePopoverMouseMove}
          >
            <MainSelectedIndexSync
              selectedIndex={selectedIndex}
              setMainSelectedIndex={setMainSelectedIndex}
            />
            <div
              ref={mainPanelRef}
              className="yolo-popover-surface yolo-popover-surface--smart-space yolo-smart-space-mention-dropdown"
            >
              <div
                key={`main:${menuContentTransition.nonce}`}
                className="yolo-smart-space-mention-list"
                role="listbox"
                data-transition={
                  menuContentTransition.direction === 'none'
                    ? undefined
                    : menuContentTransition.direction
                }
                onAnimationEnd={() =>
                  setMenuContentTransition((prev) =>
                    prev.direction === 'none'
                      ? prev
                      : { ...prev, direction: 'none' },
                  )
                }
              >
                {options.map((option, i: number) => {
                  const entryType =
                    option.payload.kind === 'entry'
                      ? option.payload.entryType
                      : null
                  const isEntryOption = entryType !== null
                  const isLeaf = entryType === 'current-file'
                  return (
                    <MentionsTypeaheadMenuItem
                      index={i}
                      isSelected={selectedIndex === i}
                      onClick={() => {
                        setHighlightedIndex(i)
                        if (
                          shouldRenderSubpanel &&
                          isEntryOption &&
                          !isLeaf &&
                          entryType !== null &&
                          subSide !== 'hidden'
                        ) {
                          cancelHoverOpen()
                          cancelHoverClose()
                          setFocusSide('main')
                          setSubHighlightedIndex(0)
                          setHoveredEntry(entryType)
                          return
                        }
                        selectOptionAndCleanUp(option)
                      }}
                      onMouseEnter={(e) => {
                        // 用当前鼠标位置主动算一次 safe triangle，避免依赖 mousemove
                        // 的事件时序导致 mouseenter 看到上一帧的 safe 状态。
                        lastCursorPosRef.current = {
                          x: e.clientX,
                          y: e.clientY,
                        }
                        const inSafe = updateSafeTriangle(e.clientX, e.clientY)
                        setSafeActive(inSafe)
                        if (focusSide === 'sub') setFocusSide('main')
                        // 主面板高亮：safe triangle 内时跳过，保持视觉跟随 hoveredEntry。
                        if (!inSafe) {
                          setHighlightedIndex(i)
                        }
                        if (
                          shouldRenderSubpanel &&
                          isEntryOption &&
                          !isLeaf &&
                          entryType !== null
                        ) {
                          if (inSafe) {
                            // Safe triangle 是真正的保护区：鼠标仍在三角路径内时，
                            // 其他主菜单项不能通过 timer 延迟提交切换。
                            cancelHoverOpen()
                          } else {
                            scheduleHoverOpen(entryType)
                          }
                        } else if (shouldRenderSubpanel && isLeaf) {
                          scheduleHoverClose()
                        }
                      }}
                      key={option.key}
                      option={option}
                    />
                  )
                })}
              </div>
            </div>
            {showSubpanel && (
              <div
                key={`sub:${previewEntryEffective}:${subSide}`}
                ref={subPanelRef}
                className="yolo-popover-surface yolo-popover-surface--smart-space yolo-smart-space-mention-dropdown yolo-smart-space-mention-subpanel"
                data-side={subSide}
                role="listbox"
                onPointerEnter={() => cancelHoverClose()}
                onPointerLeave={() => scheduleHoverClose()}
              >
                <div className="yolo-smart-space-mention-list">
                  {subOptions.map((option, i: number) => (
                    <MentionsTypeaheadMenuItem
                      index={i}
                      isSelected={
                        focusSide === 'sub' && subHighlightedIndex === i
                      }
                      onClick={() => {
                        selectOptionAndCleanUp(option)
                      }}
                      onMouseEnter={() => {
                        setFocusSide('sub')
                        setSubHighlightedIndex(i)
                        cancelHoverClose()
                      }}
                      key={`sub:${option.key}`}
                      option={option}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>,
          menuContainerRef?.current ?? anchorElementRef.current,
        )
      }}
    />
  )
}
