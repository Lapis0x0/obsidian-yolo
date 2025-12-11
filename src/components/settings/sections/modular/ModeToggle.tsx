import React from 'react'

import { ObsidianDropdown } from '../../../common/ObsidianDropdown'
import { useLanguage } from '../../../../contexts/language-context'
import { DisplayMode } from '../ModularSystemPromptSection'

interface ModeToggleProps {
  mode: DisplayMode
  onModeChange: (mode: DisplayMode) => void
  className?: string
}

const ModeToggle: React.FC<ModeToggleProps> = ({
  mode,
  onModeChange,
  className = '',
}) => {
  const { t } = useLanguage()

  const options: Record<string, string> = {
    [DisplayMode.MODULAR]: t('settings.systemPrompt.modularMode') || '模块化模式',
    [DisplayMode.PREVIEW]: t('settings.systemPrompt.previewMode') || '预览模式',
  }

  return (
    <div className={`smtcmp-mode-toggle ${className}`}>
      <ObsidianDropdown
        value={mode}
        onChange={onModeChange}
        options={options}
      />
    </div>
  )
}

export default ModeToggle