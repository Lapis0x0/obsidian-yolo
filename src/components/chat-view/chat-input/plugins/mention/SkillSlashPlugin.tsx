import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createTextNode, COMMAND_PRIORITY_NORMAL, TextNode } from 'lexical'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  FilePlus2,
  Minimize2,
  Sparkles,
  Zap,
} from 'lucide-react'
import {
  type ReactNode,
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { JSX as ReactJSX } from 'react/jsx-runtime'
import { createPortal } from 'react-dom'

import { useLanguage } from '../../../../../contexts/language-context'
import {
  LiteSkillEntry,
  humanizeSkillName,
} from '../../../../../core/skills/liteSkills'
import { SnippetEntry } from '../../../../../core/snippets/snippetsManager'
import { MenuOption } from '../shared/LexicalMenu'
import {
  LexicalTypeaheadMenuPlugin,
  useBasicTypeaheadTriggerMatch,
} from '../typeahead-menu/LexicalTypeaheadMenuPlugin'

import { $createSkillNode } from './SkillNode'

const SUGGESTION_LIST_LENGTH_LIMIT = 20
const COMPACT_COMMAND_ID = 'compact-context'
const CREATE_SNIPPETS_FILE_COMMAND_ID = 'create-snippets-file'

export type SlashCommand = {
  id: typeof COMPACT_COMMAND_ID
  name: string
  description: string
}

type SlashMenuScope = 'root' | 'skill' | 'snippet'

type SlashEntryType = 'skill' | 'snippet'

type SlashTypeaheadOptionPayload =
  | {
      kind: 'back'
      label: string
    }
  | {
      kind: 'entry'
      entryType: SlashEntryType
      label: string
    }
  | {
      kind: 'skill'
      skill: LiteSkillEntry
      isSelected: boolean
    }
  | {
      kind: 'snippet'
      snippet: SnippetEntry
    }
  | {
      kind: 'command'
      command: SlashCommand
    }
  | {
      kind: 'create-snippets-file'
      label: string
    }

class SkillTypeaheadOption extends MenuOption {
  name: string
  subtitle: string
  payload: SlashTypeaheadOptionPayload

  constructor(payload: SlashTypeaheadOptionPayload) {
    let key = 'unknown'
    let name = ''
    let subtitle = ''

    switch (payload.kind) {
      case 'back':
        key = 'slash:back'
        name = payload.label
        break
      case 'entry':
        key = `slash:entry:${payload.entryType}`
        name = payload.label
        break
      case 'skill':
        key = `slash:skill:${payload.skill.name}`
        name = humanizeSkillName(payload.skill.name)
        subtitle = payload.skill.description
        break
      case 'snippet':
        key = `slash:snippet:${payload.snippet.id}`
        name = payload.snippet.trigger
        subtitle = payload.snippet.description ?? ''
        break
      case 'command':
        key = `slash:command:${payload.command.id}`
        name = payload.command.name
        subtitle = payload.command.description
        break
      case 'create-snippets-file':
        key = `slash:command:${CREATE_SNIPPETS_FILE_COMMAND_ID}`
        name = payload.label
        break
    }

    super(key)
    this.name = name
    this.subtitle = subtitle
    this.payload = payload
  }
}

function SkillTypeaheadMenuItem({
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
  option: SkillTypeaheadOption
}) {
  let iconNode: ReactNode = null
  switch (option.payload.kind) {
    case 'back':
      iconNode = (
        <ArrowLeft size={14} className="yolo-smart-space-mention-option-icon" />
      )
      break
    case 'entry':
      iconNode =
        option.payload.entryType === 'skill' ? (
          <Sparkles
            size={14}
            className="yolo-smart-space-mention-option-icon"
          />
        ) : (
          <Zap size={14} className="yolo-smart-space-mention-option-icon" />
        )
      break
    case 'skill':
      iconNode = (
        <Sparkles size={14} className="yolo-smart-space-mention-option-icon" />
      )
      break
    case 'snippet':
      iconNode = (
        <Zap size={14} className="yolo-smart-space-mention-option-icon" />
      )
      break
    case 'command':
      iconNode = (
        <Minimize2 size={14} className="yolo-smart-space-mention-option-icon" />
      )
      break
    case 'create-snippets-file':
      iconNode = (
        <FilePlus2 size={14} className="yolo-smart-space-mention-option-icon" />
      )
      break
  }

  const isSelectedSkill =
    option.payload.kind === 'skill' && option.payload.isSelected
  const showChevron = option.payload.kind === 'entry'

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
      <div className="yolo-smart-space-mention-option-text yolo-smart-space-mention-option-text--inline-meta">
        <div className="yolo-smart-space-mention-option-name">
          {option.name}
        </div>
        {option.subtitle && (
          <div className="yolo-smart-space-mention-option-path yolo-smart-space-mention-option-inline-meta">
            {option.subtitle}
          </div>
        )}
      </div>
      {isSelectedSkill && (
        <Check size={12} className="yolo-smart-space-mention-option-check" />
      )}
      {showChevron && (
        <ChevronRight
          size={14}
          className="yolo-smart-space-mention-option-expand"
        />
      )}
    </button>
  )
}

export default function SkillSlashPlugin({
  skills,
  snippets = [],
  selectedSkillNames = [],
  mentionDisplayMode = 'inline',
  onMenuOpenChange,
  menuContainerRef,
  placement = 'top',
  onSelectSkill,
  onRunCommand,
  onCreateSnippetsFile,
}: {
  skills: LiteSkillEntry[]
  snippets?: SnippetEntry[]
  selectedSkillNames?: string[]
  mentionDisplayMode?: 'inline' | 'badge'
  onMenuOpenChange?: (isOpen: boolean) => void
  menuContainerRef?: RefObject<HTMLElement>
  placement?: 'top' | 'bottom'
  onSelectSkill?: (skill: LiteSkillEntry) => void
  onRunCommand?: (command: SlashCommand) => void
  onCreateSnippetsFile?: () => void
}): ReactJSX.Element | null {
  const [editor] = useLexicalComposerContext()
  const [queryString, setQueryString] = useState<string | null>(null)
  const [menuScope, setMenuScope] = useState<SlashMenuScope>('root')
  const { t } = useLanguage()

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

  const checkForSlashTriggerMatch = useBasicTypeaheadTriggerMatch('/', {
    minLength: 0,
  })

  const normalizedQuery = useMemo(
    () => (queryString ?? '').trim().toLowerCase(),
    [queryString],
  )

  const selectedSkillNameSet = useMemo(
    () => new Set(selectedSkillNames),
    [selectedSkillNames],
  )

  const compactCommand = useMemo<SlashCommand>(
    () => ({
      id: COMPACT_COMMAND_ID,
      name: t('chat.slashCommands.compact.label', '压缩上下文'),
      description: t(
        'chat.slashCommands.compact.description',
        '手动压缩较早对话历史，并在新的上下文窗口中继续当前任务。',
      ),
    }),
    [t],
  )

  const skillEntryLabel = t('chat.slashMenu.entrySkill', '技能')
  const snippetEntryLabel = t('chat.slashMenu.entrySnippet', '快捷指令')
  const backLabel = t('chat.mentionMenu.back', '返回上一级')
  const createSnippetsLabel = t(
    'chat.slashMenu.createSnippetsFile',
    '点击创建 snippets.md',
  )

  const filterSkills = useCallback(
    (query: string) => {
      const q = query
      return skills.filter((skill) => {
        if (!q) return true
        return (
          skill.name.toLowerCase().includes(q) ||
          skill.description.toLowerCase().includes(q) ||
          skill.path.toLowerCase().includes(q)
        )
      })
    },
    [skills],
  )

  const filterSnippets = useCallback(
    (query: string) => {
      const q = query
      return snippets.filter((snippet) => {
        if (!q) return true
        const triggerLower = snippet.trigger.toLowerCase()
        const descriptionLower = (snippet.description ?? '').toLowerCase()
        return (
          triggerLower.startsWith(q) ||
          triggerLower.includes(q) ||
          descriptionLower.includes(q)
        )
      })
    },
    [snippets],
  )

  const options = useMemo(() => {
    if (queryString == null) {
      return [] as SkillTypeaheadOption[]
    }

    if (menuScope === 'skill') {
      const skillOptions = filterSkills(normalizedQuery).map(
        (skill) =>
          new SkillTypeaheadOption({
            kind: 'skill',
            skill,
            isSelected: selectedSkillNameSet.has(skill.name),
          }),
      )
      return [
        new SkillTypeaheadOption({ kind: 'back', label: backLabel }),
        ...skillOptions,
      ].slice(0, SUGGESTION_LIST_LENGTH_LIMIT + 1)
    }

    if (menuScope === 'snippet') {
      // "Create snippets.md" appears only when the user has no snippets at all
      // (file missing or no parseable entries). Filtered-but-non-empty lists
      // should NOT show it — clicking only opens an existing file, which is
      // misleading when the user is searching within a populated library.
      if (snippets.length === 0) {
        return [
          new SkillTypeaheadOption({ kind: 'back', label: backLabel }),
          new SkillTypeaheadOption({
            kind: 'create-snippets-file',
            label: createSnippetsLabel,
          }),
        ]
      }
      const snippetOptions = filterSnippets(normalizedQuery).map(
        (snippet) =>
          new SkillTypeaheadOption({
            kind: 'snippet',
            snippet,
          }),
      )
      return [
        new SkillTypeaheadOption({ kind: 'back', label: backLabel }),
        ...snippetOptions,
      ].slice(0, SUGGESTION_LIST_LENGTH_LIMIT + 1)
    }

    // root scope
    if (normalizedQuery) {
      // Cross-category search: rank candidates by match strength rather than
      // by category order. A snippet whose trigger starts with the query must
      // outrank a skill whose only match is in its description.
      const q = normalizedQuery
      const scoreText = (text: string): number => {
        const t = text.toLowerCase()
        if (t === q) return 100
        if (t.startsWith(q)) return 80
        if (t.includes(q)) return 60
        return 0
      }

      type RankedOption = {
        option: SkillTypeaheadOption
        score: number
        categoryRank: number // tiebreaker: skill < snippet < command
        order: number // tiebreaker: preserve within-category insertion order
      }
      const ranked: RankedOption[] = []
      let orderCounter = 0

      skills.forEach((skill) => {
        const score = Math.max(
          scoreText(skill.name),
          skill.description.toLowerCase().includes(q) ? 10 : 0,
          skill.path.toLowerCase().includes(q) ? 5 : 0,
        )
        if (score === 0) return
        ranked.push({
          option: new SkillTypeaheadOption({
            kind: 'skill',
            skill,
            isSelected: selectedSkillNameSet.has(skill.name),
          }),
          score,
          categoryRank: 0,
          order: orderCounter++,
        })
      })

      snippets.forEach((snippet) => {
        const score = Math.max(
          scoreText(snippet.trigger),
          (snippet.description ?? '').toLowerCase().includes(q) ? 10 : 0,
        )
        if (score === 0) return
        ranked.push({
          option: new SkillTypeaheadOption({ kind: 'snippet', snippet }),
          score,
          categoryRank: 1,
          order: orderCounter++,
        })
      })

      const commandScore = Math.max(
        scoreText(compactCommand.name),
        compactCommand.id.toLowerCase().includes(q) ? 30 : 0,
        compactCommand.description.toLowerCase().includes(q) ? 10 : 0,
      )
      if (commandScore > 0) {
        ranked.push({
          option: new SkillTypeaheadOption({
            kind: 'command',
            command: compactCommand,
          }),
          score: commandScore,
          categoryRank: 2,
          order: orderCounter++,
        })
      }

      ranked.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score
        if (a.categoryRank !== b.categoryRank)
          return a.categoryRank - b.categoryRank
        return a.order - b.order
      })

      return ranked
        .slice(0, SUGGESTION_LIST_LENGTH_LIMIT)
        .map((entry) => entry.option)
    }

    // root scope, empty query: show three entries
    return [
      new SkillTypeaheadOption({
        kind: 'entry',
        entryType: 'skill',
        label: skillEntryLabel,
      }),
      new SkillTypeaheadOption({
        kind: 'entry',
        entryType: 'snippet',
        label: snippetEntryLabel,
      }),
      new SkillTypeaheadOption({
        kind: 'command',
        command: compactCommand,
      }),
    ]
  }, [
    backLabel,
    compactCommand,
    createSnippetsLabel,
    filterSkills,
    filterSnippets,
    menuScope,
    normalizedQuery,
    queryString,
    selectedSkillNameSet,
    skillEntryLabel,
    snippetEntryLabel,
    skills,
    snippets,
  ])

  const onSelectOption = useCallback(
    (
      selectedOption: SkillTypeaheadOption,
      nodeToReplace: TextNode | null,
      closeMenu: () => void,
    ) => {
      const payload = selectedOption.payload

      if (payload.kind === 'back') {
        if (nodeToReplace) {
          const triggerNode = $createTextNode('/')
          nodeToReplace.replace(triggerNode)
          triggerNode.selectEnd()
        }
        setMenuScope('root')
        return
      }

      if (payload.kind === 'entry') {
        if (nodeToReplace) {
          const triggerNode = $createTextNode('/')
          nodeToReplace.replace(triggerNode)
          triggerNode.selectEnd()
        }
        setMenuScope(payload.entryType === 'skill' ? 'skill' : 'snippet')
        return
      }

      if (payload.kind === 'command') {
        if (nodeToReplace) {
          const emptyNode = $createTextNode('')
          nodeToReplace.replace(emptyNode)
          emptyNode.select()
        }
        onRunCommand?.(payload.command)
        closeMenu()
        return
      }

      if (payload.kind === 'create-snippets-file') {
        if (nodeToReplace) {
          const emptyNode = $createTextNode('')
          nodeToReplace.replace(emptyNode)
          emptyNode.select()
        }
        onCreateSnippetsFile?.()
        closeMenu()
        return
      }

      if (payload.kind === 'snippet') {
        if (nodeToReplace) {
          const textNode = $createTextNode(payload.snippet.content)
          nodeToReplace.replace(textNode)
          textNode.selectEnd()
        }
        closeMenu()
        return
      }

      // payload.kind === 'skill'
      if (payload.isSelected) {
        if (nodeToReplace) {
          const emptyNode = $createTextNode('')
          nodeToReplace.replace(emptyNode)
          emptyNode.select()
        }
        closeMenu()
        return
      }

      if (mentionDisplayMode === 'badge') {
        if (nodeToReplace) {
          const emptyNode = $createTextNode('')
          nodeToReplace.replace(emptyNode)
          emptyNode.select()
        }
        onSelectSkill?.(payload.skill)
        closeMenu()
        return
      }

      if (nodeToReplace) {
        const skillNode = $createSkillNode(payload.skill.name, {
          name: payload.skill.name,
          description: payload.skill.description,
          path: payload.skill.path,
        })
        nodeToReplace.replace(skillNode)
        const spaceNode = $createTextNode(' ')
        skillNode.insertAfter(spaceNode)
        spaceNode.select()
      }
      onSelectSkill?.(payload.skill)
      closeMenu()
    },
    [mentionDisplayMode, onCreateSnippetsFile, onRunCommand, onSelectSkill],
  )

  const checkForTriggerMatch = useCallback(
    (text: string) => {
      if (
        skills.length === 0 &&
        snippets.length === 0 &&
        !onRunCommand &&
        !onCreateSnippetsFile
      ) {
        return null
      }
      return checkForSlashTriggerMatch(text, editor)
    },
    [
      checkForSlashTriggerMatch,
      editor,
      onCreateSnippetsFile,
      onRunCommand,
      skills.length,
      snippets.length,
    ],
  )

  const getDefaultHighlightedIndex = useCallback(
    (menuOptions: SkillTypeaheadOption[]) => {
      if (menuScope === 'root') {
        return 0
      }
      const firstOption = menuOptions[0]
      if (firstOption?.payload.kind === 'back' && menuOptions.length > 1) {
        return 1
      }
      return 0
    },
    [menuScope],
  )

  return (
    <LexicalTypeaheadMenuPlugin<SkillTypeaheadOption>
      onQueryChange={setQueryString}
      onSelectOption={onSelectOption}
      triggerFn={checkForTriggerMatch}
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
                className="yolo-smart-space-mention-popover"
                data-placement={placement}
              >
                <div className="yolo-popover-surface yolo-popover-surface--smart-space yolo-smart-space-mention-dropdown">
                  <div
                    className="yolo-smart-space-mention-list"
                    role="listbox"
                    aria-label={skillEntryLabel}
                  >
                    {options.map((option, index) => (
                      <SkillTypeaheadMenuItem
                        key={option.key}
                        index={index}
                        isSelected={selectedIndex === index}
                        onClick={() => {
                          setHighlightedIndex(index)
                          selectOptionAndCleanUp(option)
                        }}
                        onMouseEnter={() => {
                          setHighlightedIndex(index)
                        }}
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
