import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createTextNode, COMMAND_PRIORITY_NORMAL, TextNode } from 'lexical'
import { Check, Sparkles } from 'lucide-react'
import { RefObject, useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX as ReactJSX } from 'react/jsx-runtime'
import { createPortal } from 'react-dom'

import { useLanguage } from '../../../../../contexts/language-context'
import { LiteSkillEntry } from '../../../../../core/skills/liteSkills'
import { MenuOption } from '../shared/LexicalMenu'
import { $createSkillNode } from './SkillNode'
import {
  LexicalTypeaheadMenuPlugin,
  useBasicTypeaheadTriggerMatch,
} from '../typeahead-menu/LexicalTypeaheadMenuPlugin'

const SUGGESTION_LIST_LENGTH_LIMIT = 20

class SkillTypeaheadOption extends MenuOption {
  name: string
  subtitle: string
  skill: LiteSkillEntry
  isSelectedSkill: boolean

  constructor(skill: LiteSkillEntry, isSelectedSkill: boolean) {
    super(`skill:${skill.id}`)
    this.name = skill.name
    this.subtitle = skill.description
    this.skill = skill
    this.isSelectedSkill = isSelectedSkill
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
      <Sparkles size={14} className="smtcmp-smart-space-mention-option-icon" />
      <div className="smtcmp-smart-space-mention-option-text smtcmp-smart-space-mention-option-text--inline-meta">
        <div className="smtcmp-smart-space-mention-option-name">
          {option.name}
        </div>
        {option.subtitle && (
          <div className="smtcmp-smart-space-mention-option-path smtcmp-smart-space-mention-option-inline-meta">
            {option.subtitle}
          </div>
        )}
      </div>
      {option.isSelectedSkill && (
        <Check size={12} className="smtcmp-smart-space-mention-option-check" />
      )}
    </button>
  )
}

export default function SkillSlashPlugin({
  skills,
  selectedSkillIds = [],
  mentionDisplayMode = 'inline',
  onMenuOpenChange,
  menuContainerRef,
  placement = 'top',
  onSelectSkill,
}: {
  skills: LiteSkillEntry[]
  selectedSkillIds?: string[]
  mentionDisplayMode?: 'inline' | 'badge'
  onMenuOpenChange?: (isOpen: boolean) => void
  menuContainerRef?: RefObject<HTMLElement>
  placement?: 'top' | 'bottom'
  onSelectSkill?: (skill: LiteSkillEntry) => void
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

  const selectedSkillIdSet = useMemo(
    () => new Set(selectedSkillIds),
    [selectedSkillIds],
  )

  const options = useMemo(() => {
    if (queryString == null) {
      return [] as SkillTypeaheadOption[]
    }

    return skills
      .filter((skill) => {
        if (!normalizedQuery) return true
        return (
          skill.name.toLowerCase().includes(normalizedQuery) ||
          skill.id.toLowerCase().includes(normalizedQuery) ||
          skill.description.toLowerCase().includes(normalizedQuery) ||
          skill.path.toLowerCase().includes(normalizedQuery)
        )
      })
      .map(
        (skill) =>
          new SkillTypeaheadOption(skill, selectedSkillIdSet.has(skill.id)),
      )
      .slice(0, SUGGESTION_LIST_LENGTH_LIMIT)
  }, [normalizedQuery, queryString, selectedSkillIdSet, skills])

  const onSelectOption = useCallback(
    (
      selectedOption: SkillTypeaheadOption,
      nodeToReplace: TextNode | null,
      closeMenu: () => void,
    ) => {
      if (selectedOption.isSelectedSkill) {
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
        onSelectSkill?.(selectedOption.skill)
        closeMenu()
        return
      }

      if (nodeToReplace) {
        const skillNode = $createSkillNode(selectedOption.skill.name, {
          id: selectedOption.skill.id,
          name: selectedOption.skill.name,
          description: selectedOption.skill.description,
          path: selectedOption.skill.path,
        })
        nodeToReplace.replace(skillNode)
        const spaceNode = $createTextNode(' ')
        skillNode.insertAfter(spaceNode)
        spaceNode.select()
      }
      onSelectSkill?.(selectedOption.skill)
      closeMenu()
    },
    [mentionDisplayMode, onSelectSkill],
  )

  const checkForTriggerMatch = useCallback(
    (text: string) => {
      if (skills.length === 0) {
        return null
      }
      return checkForSlashTriggerMatch(text, editor)
    },
    [checkForSlashTriggerMatch, editor, skills.length],
  )

  return (
    <LexicalTypeaheadMenuPlugin<SkillTypeaheadOption>
      onQueryChange={setQueryString}
      onSelectOption={onSelectOption}
      triggerFn={checkForTriggerMatch}
      options={options}
      commandPriority={COMMAND_PRIORITY_NORMAL}
      getDefaultHighlightedIndex={() => 0}
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
                    aria-label={t('chat.mentionMenu.entrySkill', '技能')}
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
