import * as Popover from '@radix-ui/react-popover'
import { X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ModularPromptData, PromptGroup, PromptModule } from '../../../settings/schema/setting.types'
import { SystemPromptGenerator } from '../../../utils/systemPromptGenerator'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { PromptToggleItem } from './PromptToggleItem'
import './styles.css'

export type SystemPromptPopoverProps = {
  onClose: () => void
}

export const SystemPromptPopover: React.FC<SystemPromptPopoverProps> = ({ onClose }) => {
  const { settings, setSettings } = useSettings()

  // 实时处理提示词开关
  const handleTogglePrompt = useCallback(async (groupId: string, promptId: string, enabled: boolean) => {
    const currentData = settings.modularPromptData || { groups: [] }
    const updatedData = {
      ...currentData,
      groups: currentData.groups.map(group => {
        if (group.id === groupId) {
          const updatedPrompts = group.prompts.map(prompt =>
            prompt.id === promptId ? { ...prompt, enabled } : prompt
          )
          return { ...group, prompts: updatedPrompts }
        }
        return group
      })
    }

    try {
      // 实时生成新的系统提示词
      const newSystemPrompt = SystemPromptGenerator.generateSystemPrompt(updatedData)
      
      // 实时更新设置
      await setSettings({
        ...settings,
        modularPromptData: updatedData,
        systemPrompt: newSystemPrompt
      })
    } catch (error) {
      console.error('Failed to apply system prompt changes:', error)
    }
  }, [settings, setSettings])

  return (
    <Popover.Portal>
      <Popover.Content
        className="smtcmp-popover smtcmp-system-prompt-popover"
        sideOffset={8}
        align="end"
        collisionPadding={8}
        style={{
          width: '240px',
          minWidth: '240px',
          maxWidth: '240px',
          height: 'auto',
          overflow: 'visible'
        }}
      >
        <div className="smtcmp-system-prompt-popover-content">
          {(settings.modularPromptData?.groups?.length || 0) === 0 ? (
            <div className="smtcmp-system-prompt-empty">
              暂无系统提示词
            </div>
          ) : (
            settings.modularPromptData?.groups?.flatMap(group =>
              group.prompts.map(prompt => (
                <PromptToggleItem
                  key={prompt.id}
                  prompt={prompt}
                  groupId={group.id}
                  onToggle={handleTogglePrompt}
                />
              ))
            ) || []
          )}
        </div>
      </Popover.Content>
    </Popover.Portal>
  )
}