import * as Popover from '@radix-ui/react-popover'
import { ChevronDown, ChevronUp } from 'lucide-react'
import React, { useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { useSettings } from '../../contexts/settings-context'
import { Assistant } from '../../types/assistant.types'

export function AssistantSelector() {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)

  // Get assistant list and currently selected assistant
  const assistants = settings.assistants || []
  const currentAssistantId = settings.currentAssistantId

  // Get the current assistant object
  const currentAssistant = assistants.find((a) => a.id === currentAssistantId)

  // Handler function for selecting an assistant
  const handleSelectAssistant = async (assistant: Assistant) => {
    await setSettings({
      ...settings,
      currentAssistantId: assistant.id,
    })
    setOpen(false)
  }

  // Handler function for selecting "no assistant"
  const handleSelectNoAssistant = async () => {
    await setSettings({
      ...settings,
      currentAssistantId: undefined,
    })
    setOpen(false)
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="smtcmp-assistant-selector-button">
          <div className="smtcmp-assistant-selector-current">
            {currentAssistant
              ? currentAssistant.name
              : t('settings.assistants.noAssistant')}
          </div>
          <div className="smtcmp-assistant-selector-icon">
            {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </div>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content className="smtcmp-popover smtcmp-assistant-selector-content">
          <ul className="smtcmp-assistant-selector-list">
            {/* "No Assistant" option */}
            <li
              className={`smtcmp-assistant-selector-item ${
                !currentAssistantId ? 'selected' : ''
              }`}
              onClick={handleSelectNoAssistant}
            >
              <div className="smtcmp-assistant-selector-item-name">
                {t('settings.assistants.noAssistant')}
              </div>
            </li>

            {/* Available assistants */}
            {assistants.map((assistant) => (
              <li
                key={assistant.id}
                className={`smtcmp-assistant-selector-item ${
                  assistant.id === currentAssistantId ? 'selected' : ''
                }`}
                onClick={() => handleSelectAssistant(assistant)}
              >
                <div className="smtcmp-assistant-selector-item-name">
                  {assistant.name}
                </div>
                {assistant.description && (
                  <div className="smtcmp-assistant-selector-item-description">
                    {assistant.description}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
