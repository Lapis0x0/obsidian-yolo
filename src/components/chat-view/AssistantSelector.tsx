import * as Popover from '@radix-ui/react-popover'
import { ChevronDown, ChevronUp } from 'lucide-react'
import React, { useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { useSettings } from '../../contexts/settings-context'
import {
  DEFAULT_ASSISTANT_ID,
  isDefaultAssistantId,
} from '../../core/agent/default-assistant'
import { Assistant } from '../../types/assistant.types'
import { getNodeBody } from '../../utils/dom/window-context'
import { renderAssistantIcon } from '../../utils/assistant-icon'

type AssistantSelectorProps = {
  currentAssistantId?: string
  onAssistantChange?: (assistant: Assistant) => void
  triggerClassName?: string
  contentClassName?: string
}

export function AssistantSelector({
  currentAssistantId,
  onAssistantChange,
  triggerClassName,
  contentClassName,
}: AssistantSelectorProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const isControlled = typeof currentAssistantId === 'string'

  // Get assistant list and currently selected assistant
  const assistants = settings.assistants || []
  const resolvedCurrentAssistantId =
    currentAssistantId ?? settings.currentAssistantId ?? DEFAULT_ASSISTANT_ID

  // Get the current assistant object
  const currentAssistant = assistants.find(
    (a) => a.id === resolvedCurrentAssistantId,
  )

  // Handler function for selecting an assistant
  const handleSelectAssistant = (assistant: Assistant) => {
    if (isControlled) {
      onAssistantChange?.(assistant)
      setOpen(false)
      return
    }
    void (async () => {
      try {
        await setSettings({
          ...settings,
          currentAssistantId: assistant.id,
        })
        onAssistantChange?.(assistant)
        setOpen(false)
      } catch (error: unknown) {
        console.error('Failed to select assistant', error)
      }
    })()
  }

  // Handler function for selecting default assistant
  const handleSelectDefaultAssistant = () => {
    if (isControlled) {
      const fallbackDefaultAssistant = assistants.find((assistant) =>
        isDefaultAssistantId(assistant.id),
      )
      if (fallbackDefaultAssistant) {
        onAssistantChange?.(fallbackDefaultAssistant)
      }
      setOpen(false)
      return
    }
    void (async () => {
      try {
        await setSettings({
          ...settings,
          currentAssistantId: DEFAULT_ASSISTANT_ID,
        })
        const fallbackDefaultAssistant = assistants.find((assistant) =>
          isDefaultAssistantId(assistant.id),
        )
        if (fallbackDefaultAssistant) {
          onAssistantChange?.(fallbackDefaultAssistant)
        }
        setOpen(false)
      } catch (error: unknown) {
        console.error('Failed to select default assistant', error)
      }
    })()
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          ref={triggerRef}
          className={`smtcmp-assistant-selector-button${
            triggerClassName ? ` ${triggerClassName}` : ''
          }`}
          data-state={open ? 'open' : 'closed'}
        >
          {currentAssistant && (
            <div className="smtcmp-assistant-selector-current-icon">
              {renderAssistantIcon(currentAssistant.icon, 14)}
            </div>
          )}
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

      <Popover.Portal container={getNodeBody(triggerRef.current)}>
        <Popover.Content
          className={`smtcmp-popover smtcmp-chat-sidebar-popover smtcmp-assistant-selector-content${
            contentClassName ? ` ${contentClassName}` : ''
          }`}
          sideOffset={14}
        >
          <ul className="smtcmp-assistant-selector-list smtcmp-model-select-list">
            {/* "No Assistant" option */}
            <li className="smtcmp-assistant-selector-row">
              <button
                type="button"
                className={`smtcmp-assistant-selector-item ${
                  isDefaultAssistantId(resolvedCurrentAssistantId)
                    ? 'selected'
                    : ''
                }`}
                onClick={handleSelectDefaultAssistant}
              >
                <div className="smtcmp-assistant-selector-item-content">
                  <div className="smtcmp-assistant-selector-item-name">
                    {assistants.find((assistant) =>
                      isDefaultAssistantId(assistant.id),
                    )?.name ?? t('settings.assistants.noAssistant')}
                  </div>
                </div>
              </button>
            </li>

            {/* Available assistants */}
            {assistants
              .filter((assistant) => !isDefaultAssistantId(assistant.id))
              .map((assistant) => (
                <li
                  key={assistant.id}
                  className="smtcmp-assistant-selector-row"
                >
                  <button
                    type="button"
                    className={`smtcmp-assistant-selector-item ${
                      assistant.id === resolvedCurrentAssistantId
                        ? 'selected'
                        : ''
                    }`}
                    onClick={() => handleSelectAssistant(assistant)}
                  >
                    <div className="smtcmp-assistant-selector-item-icon">
                      {renderAssistantIcon(assistant.icon, 14)}
                    </div>
                    <div className="smtcmp-assistant-selector-item-content">
                      <div className="smtcmp-assistant-selector-item-name">
                        {assistant.name}
                      </div>
                      {assistant.description && (
                        <div className="smtcmp-assistant-selector-item-description">
                          {assistant.description}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
