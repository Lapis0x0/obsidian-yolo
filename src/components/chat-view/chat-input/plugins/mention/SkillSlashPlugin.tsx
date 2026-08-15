import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createTextNode, COMMAND_PRIORITY_NORMAL, TextNode } from 'lexical'
import { Blocks, FilePlus2, Minimize2, Plug, Sparkles, Zap } from 'lucide-react'
import {
  type ReactNode,
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { JSX as ReactJSX } from 'react/jsx-runtime'

import { useLanguage } from '../../../../../contexts/language-context'
import {
  LiteSkillEntry,
  humanizeSkillName,
} from '../../../../../core/skills/liteSkills'
import { SnippetEntry } from '../../../../../core/snippets/snippetsManager'
import { MenuOption } from '../shared/LexicalMenu'
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

import { $createSkillNode } from './SkillNode'

const SUGGESTION_LIST_LENGTH_LIMIT = 20
const CREATE_SNIPPETS_FILE_COMMAND_ID = 'create-snippets-file'

export type SlashCommand = {
  id: 'compact-context' | 'open-plugin-manager' | 'open-mcp-servers'
  name: string
  description: string
}

type SlashTypeaheadOptionPayload =
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

function SkillSlashOptionRow(props: RailMenuItemProps<SkillTypeaheadOption>) {
  const { option } = props
  let iconNode: ReactNode = null
  switch (option.payload.kind) {
    case 'skill':
      iconNode = <Sparkles size={15} className="yolo-rail-menu-row-icon" />
      break
    case 'snippet':
      iconNode = <Zap size={15} className="yolo-rail-menu-row-icon" />
      break
    case 'command':
      iconNode =
        option.payload.command.id === 'open-plugin-manager' ? (
          <Blocks size={15} className="yolo-rail-menu-row-icon" />
        ) : option.payload.command.id === 'open-mcp-servers' ? (
          <Plug size={15} className="yolo-rail-menu-row-icon" />
        ) : (
          <Minimize2 size={15} className="yolo-rail-menu-row-icon" />
        )
      break
    case 'create-snippets-file':
      iconNode = <FilePlus2 size={15} className="yolo-rail-menu-row-icon" />
      break
  }

  return (
    <RailMenuRow
      {...props}
      icon={iconNode}
      name={option.name}
      description={option.subtitle}
    />
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
  nativeCommands = [],
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
  /** Runtime-specific native commands (e.g. Claude plugin manager, MCP status). Component stays runtime-agnostic. */
  nativeCommands?: SlashCommand[]
}): ReactJSX.Element | null {
  const [editor] = useLexicalComposerContext()
  const [queryString, setQueryString] = useState<string | null>(null)
  const { t } = useLanguage()

  useEffect(() => {
    return () => {
      onMenuOpenChange?.(false)
    }
  }, [onMenuOpenChange])

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

  const skillCategoryLabel = t('chat.slashMenu.entrySkill', '技能')
  const snippetCategoryLabel = t('chat.slashMenu.entrySnippet', '快捷指令')
  const commandCategoryLabel = t('chat.slashMenu.categoryCommand', '命令')
  const categoryEmptyLabel = t('chat.slashMenu.categoryEmpty', '暂无内容')
  const createSnippetsLabel = t(
    'chat.slashMenu.createSnippetsFile',
    '点击创建 snippets.md',
  )

  const allCommands = nativeCommands

  const skillOptions = useMemo(
    () =>
      skills.map(
        (skill) =>
          new SkillTypeaheadOption({
            kind: 'skill',
            skill,
            isSelected: selectedSkillNameSet.has(skill.name),
          }),
      ),
    [selectedSkillNameSet, skills],
  )

  const snippetOptions = useMemo(
    () =>
      snippets.length === 0
        ? [
            new SkillTypeaheadOption({
              kind: 'create-snippets-file',
              label: createSnippetsLabel,
            }),
          ]
        : snippets.map(
            (snippet) => new SkillTypeaheadOption({ kind: 'snippet', snippet }),
          ),
    [createSnippetsLabel, snippets],
  )

  const commandOptions = useMemo(
    () =>
      allCommands.map(
        (command) => new SkillTypeaheadOption({ kind: 'command', command }),
      ),
    [allCommands],
  )

  const categories = useMemo<RailMenuCategory<SkillTypeaheadOption>[]>(
    () => [
      {
        key: 'skill',
        label: skillCategoryLabel,
        icon: <Sparkles size={13} className="yolo-rail-menu-rail-item-icon" />,
        options: skillOptions,
        count: skillOptions.length,
      },
      {
        key: 'snippet',
        label: snippetCategoryLabel,
        icon: <Zap size={13} className="yolo-rail-menu-rail-item-icon" />,
        options: snippetOptions,
        count: snippetOptions.length,
      },
      {
        key: 'command',
        label: commandCategoryLabel,
        icon: <Minimize2 size={13} className="yolo-rail-menu-rail-item-icon" />,
        options: commandOptions,
        count: commandOptions.length,
      },
    ],
    [
      commandCategoryLabel,
      commandOptions,
      skillCategoryLabel,
      skillOptions,
      snippetCategoryLabel,
      snippetOptions,
    ],
  )

  // 跨类别打分排序：过滤态下 snippet 的 trigger 前缀匹配要能压过 skill 只在
  // 描述里命中的情况，所以不是按类别顺序简单拼接，而是统一算分后排序。
  const filteredOptions = useMemo<SkillTypeaheadOption[] | null>(() => {
    if (!normalizedQuery) return null

    const q = normalizedQuery
    const scoreText = (text: string): number => {
      const lower = text.toLowerCase()
      if (lower === q) return 100
      if (lower.startsWith(q)) return 80
      if (lower.includes(q)) return 60
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

    allCommands.forEach((command) => {
      const commandScore = Math.max(
        scoreText(command.name),
        command.id.toLowerCase().includes(q) ? 30 : 0,
        command.description.toLowerCase().includes(q) ? 10 : 0,
      )
      if (commandScore === 0) return
      ranked.push({
        option: new SkillTypeaheadOption({ kind: 'command', command }),
        score: commandScore,
        categoryRank: 2,
        order: orderCounter++,
      })
    })

    ranked.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      if (a.categoryRank !== b.categoryRank)
        return a.categoryRank - b.categoryRank
      return a.order - b.order
    })

    return ranked
      .slice(0, SUGGESTION_LIST_LENGTH_LIMIT)
      .map((entry) => entry.option)
  }, [allCommands, normalizedQuery, selectedSkillNameSet, skills, snippets])

  const railMenu = useRailTypeaheadMenu({
    categories,
    flatOptions: filteredOptions,
    placement,
  })

  const options = railMenu.displayOptions

  const onSelectOption = useCallback(
    (
      selectedOption: SkillTypeaheadOption,
      nodeToReplace: TextNode | null,
      closeMenu: () => void,
    ) => {
      const payload = selectedOption.payload

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

  return (
    <LexicalTypeaheadMenuPlugin<SkillTypeaheadOption>
      onQueryChange={setQueryString}
      onSelectOption={onSelectOption}
      triggerFn={checkForTriggerMatch}
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
          emptyLabel: categoryEmptyLabel,
          renderItem: (props) => (
            <SkillSlashOptionRow
              {...props}
              key={`${props.id}:${props.option.key}`}
            />
          ),
        })
      }
    />
  )
}
