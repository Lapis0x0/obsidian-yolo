import * as Popover from '@radix-ui/react-popover'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Cpu,
  Pencil,
  Settings,
  Wrench,
} from 'lucide-react'
import { useRef, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import {
  DEFAULT_ASSISTANT_ID,
  isDefaultAssistantId,
} from '../../core/agent/default-assistant'
import { getEnabledAssistantToolNames } from '../../core/agent/tool-preferences'
import { Assistant } from '../../types/assistant.types'
import { renderAssistantIcon } from '../../utils/assistant-icon'
import { YoloPopoverContent } from '../common/popover'
import { AssistantsModal } from '../settings/modals/AssistantsModal'

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
  const app = useApp()
  const plugin = usePlugin()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const isControlled = typeof currentAssistantId === 'string'

  const assistants = settings.assistants || []
  const resolvedCurrentAssistantId =
    currentAssistantId ?? settings.currentAssistantId ?? DEFAULT_ASSISTANT_ID

  const currentAssistant = assistants.find(
    (a) => a.id === resolvedCurrentAssistantId,
  )

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

  const handleSelectDefaultAssistant = () => {
    const fallbackDefaultAssistant = assistants.find((assistant) =>
      isDefaultAssistantId(assistant.id),
    )
    if (isControlled) {
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
        if (fallbackDefaultAssistant) {
          onAssistantChange?.(fallbackDefaultAssistant)
        }
        setOpen(false)
      } catch (error: unknown) {
        console.error('Failed to select default assistant', error)
      }
    })()
  }

  const handleEditAssistant = (assistantId: string) => {
    setOpen(false)
    const modal = new AssistantsModal(app, plugin, assistantId, false)
    modal.open()
  }

  const handleManageAll = () => {
    setOpen(false)
    // Pre-select the Agent tab; SettingsTabs reads this on mount.
    // Key kept in sync with SettingsTabs.STORAGE_KEY.
    app.saveLocalStorage('yolo_settings_active_tab', 'agent')
    // @ts-expect-error: setting property exists in Obsidian's App but is not typed
    app.setting.open()
    // @ts-expect-error: setting property exists in Obsidian's App but is not typed
    app.setting.openTabById(plugin.manifest.id)
  }

  const defaultAssistant = assistants.find((assistant) =>
    isDefaultAssistantId(assistant.id),
  )
  const customAssistants = assistants.filter(
    (assistant) => !isDefaultAssistantId(assistant.id),
  )
  const fallbackModelId = settings.chatModelId

  const renderMetaRow = (assistant: Assistant) => {
    const rawModelId = assistant.modelId || fallbackModelId || ''
    const modelLabel = rawModelId.includes('/')
      ? rawModelId.slice(rawModelId.lastIndexOf('/') + 1)
      : rawModelId
    const toolCount = assistant.enableTools
      ? getEnabledAssistantToolNames(assistant).length
      : 0
    return (
      <div className="yolo-assistant-selector-item-meta">
        {modelLabel && (
          <span className="yolo-assistant-selector-meta-chip">
            <Cpu size={10} />
            <span>{modelLabel}</span>
          </span>
        )}
        <span className="yolo-assistant-selector-meta-chip">
          <Wrench size={10} />
          <span>
            {t('settings.agent.toolsCount', '{count} tools').replace(
              '{count}',
              String(toolCount),
            )}
          </span>
        </span>
      </div>
    )
  }

  const renderAssistantRow = (assistant: Assistant) => {
    const isDefault = isDefaultAssistantId(assistant.id)
    const isActive = isDefault
      ? isDefaultAssistantId(resolvedCurrentAssistantId)
      : assistant.id === resolvedCurrentAssistantId
    const onSelect = isDefault
      ? handleSelectDefaultAssistant
      : () => handleSelectAssistant(assistant)
    return (
      <li key={assistant.id} className="yolo-assistant-selector-row">
        <div
          className={`yolo-assistant-selector-item ${
            isActive ? 'selected' : ''
          }`}
        >
          <button
            type="button"
            className="yolo-assistant-selector-item-main"
            onClick={onSelect}
          >
            <div className="yolo-assistant-selector-item-icon">
              {renderAssistantIcon(assistant.icon, 14)}
            </div>
            <div className="yolo-assistant-selector-item-content">
              <div className="yolo-assistant-selector-item-name-row">
                <span className="yolo-assistant-selector-item-name">
                  {assistant.name}
                </span>
                {isActive && (
                  <Check
                    size={11}
                    className="yolo-assistant-selector-item-check"
                  />
                )}
              </div>
              {renderMetaRow(assistant)}
            </div>
          </button>
          <div className="yolo-assistant-selector-item-actions">
            <button
              type="button"
              className="yolo-assistant-selector-action-btn"
              aria-label={t('settings.assistants.editAssistant')}
              onClick={(event) => {
                event.stopPropagation()
                handleEditAssistant(assistant.id)
              }}
            >
              <Pencil size={12} />
            </button>
          </div>
        </div>
      </li>
    )
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          ref={triggerRef}
          className={`yolo-assistant-selector-button${
            triggerClassName ? ` ${triggerClassName}` : ''
          }`}
          data-state={open ? 'open' : 'closed'}
        >
          {currentAssistant && (
            <div className="yolo-assistant-selector-current-icon">
              {renderAssistantIcon(currentAssistant.icon, 14)}
            </div>
          )}
          <div className="yolo-assistant-selector-current">
            {currentAssistant
              ? currentAssistant.name
              : t('settings.assistants.noAssistant')}
          </div>
          <div className="yolo-assistant-selector-icon">
            {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </div>
        </button>
      </Popover.Trigger>

      <YoloPopoverContent
        anchorRef={triggerRef}
        variant="default"
        minWidth={280}
        maxHeight={460}
        className={`yolo-assistant-selector-content yolo-assistant-selector-content--palette${
          contentClassName ? ` ${contentClassName}` : ''
        }`}
        sideOffset={14}
      >
        <ul className="yolo-assistant-selector-list yolo-model-select-list">
          {defaultAssistant && renderAssistantRow(defaultAssistant)}
          {customAssistants.map((assistant) => renderAssistantRow(assistant))}
        </ul>

        <div className="yolo-assistant-selector-footer">
          <button
            type="button"
            className="yolo-assistant-selector-footer-btn"
            onClick={handleManageAll}
          >
            <Settings size={12} />
            <span>{t('settings.assistants.manageAll', 'Manage all…')}</span>
          </button>
        </div>
      </YoloPopoverContent>
    </Popover.Root>
  )
}
