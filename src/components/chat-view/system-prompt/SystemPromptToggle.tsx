import * as Popover from '@radix-ui/react-popover'
import { Settings } from 'lucide-react'
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { SystemPromptPopover } from './SystemPromptPopover'
import './styles.css'

export type SystemPromptToggleRef = {
  focus: () => void
}

export type SystemPromptToggleProps = {
  onToggle?: (isOpen: boolean) => void
}

export const SystemPromptToggle = forwardRef<SystemPromptToggleRef, SystemPromptToggleProps>(
  ({ onToggle }, ref) => {
    const { t } = useLanguage()
    const [isOpen, setIsOpen] = useState(false)
    const buttonRef = useRef<HTMLButtonElement>(null)

    const handleToggle = (open: boolean) => {
      setIsOpen(open)
      onToggle?.(open)
    }

    useImperativeHandle(ref, () => ({
      focus: () => {
        buttonRef.current?.focus()
      }
    }))

    return (
      <Popover.Root open={isOpen} onOpenChange={handleToggle}>
        <Popover.Trigger asChild>
          <button
            ref={buttonRef}
            className="smtcmp-system-prompt-toggle-button"
            aria-label={t('chat.systemPrompt.toggleAria', '打开系统提示词设置')}
            title={t('chat.systemPrompt.toggleTitle', '管理系统提示词')}
          >
            <Settings size={16} />
          </button>
        </Popover.Trigger>
        <SystemPromptPopover onClose={() => handleToggle(false)} />
      </Popover.Root>
    )
  },
)

SystemPromptToggle.displayName = 'SystemPromptToggle'