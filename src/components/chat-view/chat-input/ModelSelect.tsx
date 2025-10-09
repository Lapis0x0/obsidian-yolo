import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'

import { useSettings } from '../../../contexts/settings-context'
import { getModelDisplayName } from '../../../utils/model-id-utils'

export function ModelSelect({
  modelId: externalModelId,
  onChange,
}: {
  modelId?: string
  onChange?: (modelId: string) => void
} = {}) {
  const { settings, setSettings } = useSettings()
  const [isOpen, setIsOpen] = useState(false)

  // Get provider name for current model
  const getCurrentModelDisplay = () => {
    const effectiveModelId = externalModelId ?? settings.chatModelId
    const currentModel = settings.chatModels.find(
      (m) => m.id === effectiveModelId,
    )
    if (currentModel) {
      // 优先显示「展示名称」，其次调用ID(model)，最后回退到内部 id
      const provider = settings.providers.find(
        (p) => p.id === currentModel.providerId,
      )
      const display = currentModel.name || currentModel.model || currentModel.id
      // 使用 provider 展示后缀
      const suffix = provider?.id ? ` (${provider.id})` : ''
      return `${display}${suffix}`
    }
    return effectiveModelId
  }

  return (
    <DropdownMenu.Root open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenu.Trigger className="smtcmp-chat-input-model-select">
        <div className="smtcmp-chat-input-model-select__model-name">
          {getCurrentModelDisplay()}
        </div>
        <div className="smtcmp-chat-input-model-select__icon">
          {isOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </div>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="smtcmp-popover">
          <ul className="smtcmp-model-select-list">
            {(() => {
              const enabledModels = settings.chatModels.filter(
                ({ enable }) => enable ?? true,
              )
              const providerOrder = settings.providers.map((p) => p.id)
              const providerIdsInModels = Array.from(
                new Set(enabledModels.map((m) => m.providerId)),
              )
              const orderedProviderIds = [
                ...providerOrder.filter((id) =>
                  providerIdsInModels.includes(id),
                ),
                ...providerIdsInModels.filter(
                  (id) => !providerOrder.includes(id),
                ),
              ]

              return orderedProviderIds.flatMap((pid, groupIndex) => {
                const groupModels = enabledModels.filter(
                  (m) => m.providerId === pid,
                )
                if (groupModels.length === 0) return []

                const groupHeader = (
                  <DropdownMenu.Label
                    key={`label-${pid}`}
                    className="smtcmp-popover-group-label"
                  >
                    {pid}
                  </DropdownMenu.Label>
                )

                const items = groupModels.map((chatModelOption) => {
                  // 列表项名称：优先显示「展示名称」，其次调用ID(model)，最后回退到内部 id
                  const displayName =
                    chatModelOption.name ||
                    chatModelOption.model ||
                    getModelDisplayName(chatModelOption.id)
                  return (
                    <DropdownMenu.Item
                      key={chatModelOption.id}
                      onSelect={() => {
                        if (onChange) {
                          onChange(chatModelOption.id)
                        } else {
                          setSettings({
                            ...settings,
                            chatModelId: chatModelOption.id,
                          })
                        }
                      }}
                      asChild
                    >
                      <li>{displayName}</li>
                    </DropdownMenu.Item>
                  )
                })

                return [
                  groupHeader,
                  ...items,
                  ...(groupIndex < orderedProviderIds.length - 1
                    ? [
                        <DropdownMenu.Separator
                          key={`sep-${pid}`}
                          className="smtcmp-popover-group-separator"
                        />,
                      ]
                    : []),
                ]
              })
            })()}
          </ul>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
