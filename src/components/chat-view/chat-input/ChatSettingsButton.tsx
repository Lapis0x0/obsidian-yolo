import * as Popover from '@radix-ui/react-popover'
import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { ChatModel } from '../../../types/chat-model.types'
import { ConversationOverrideSettings } from '../../../types/conversation-settings.types'
import { getNodeBody, getNodeWindow } from '../../../utils/dom/window-context'

export default function ChatSettingsButton({
  overrides,
  onChange,
}: {
  overrides?: ConversationOverrideSettings | null
  onChange?: (overrides: ConversationOverrideSettings) => void
  currentModel?: ChatModel
}) {
  const { t } = useLanguage()
  const value = useMemo<ConversationOverrideSettings>(() => {
    return {
      useVaultSearch: overrides?.useVaultSearch ?? false,
    }
  }, [overrides])

  const updateVaultSearch = (enabled: boolean) => {
    onChange?.({
      ...overrides,
      temperature: null,
      top_p: null,
      maxContextMessages: null,
      stream: null,
      useVaultSearch: enabled,
      useWebSearch: false,
      useUrlContext: false,
    })
  }

  // Measure input wrapper width to set popover width = 50% of it (with a min width)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [panelWidth, setPanelWidth] = useState<number | undefined>(undefined)
  useEffect(() => {
    const btn = triggerRef.current
    if (!btn) return
    const wrapper = btn.closest('.smtcmp-chat-input-wrapper')
    if (!wrapper) return

    const MIN_WIDTH = 200
    const compute = () => {
      const w = wrapper.clientWidth
      setPanelWidth(Math.max(MIN_WIDTH, Math.floor(w * 0.4)))
    }
    compute()

    const onResize = () => compute()
    const ownerWindow = getNodeWindow(btn)

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(onResize)
      ro.observe(wrapper)
      return () => ro.disconnect()
    } else {
      ownerWindow.addEventListener('resize', onResize)
      return () => ownerWindow.removeEventListener('resize', onResize)
    }
  }, [])

  const popoverWidthStyle = useMemo(() => {
    if (typeof panelWidth !== 'number') return {}
    return { width: `${panelWidth}px` }
  }, [panelWidth])

  const popoverClassName = 'smtcmp-popover-content smtcmp-chat-settings-content'

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          ref={triggerRef}
          className="clickable-icon"
          aria-label={t(
            'chat.conversationSettings.openAria',
            'Conversation settings',
          )}
        >
          <SlidersHorizontal size={14} />
        </button>
      </Popover.Trigger>
      <Popover.Portal container={getNodeBody(triggerRef.current)}>
        <Popover.Content
          className={popoverClassName}
          style={popoverWidthStyle}
          side="bottom"
          align="end"
          sideOffset={6}
        >
          <div className="smtcmp-chat-settings">
            <div className="smtcmp-chat-settings-section">
              <div className="smtcmp-chat-settings-section-title">
                {t('chat.conversationSettings.vaultSearch', 'Vault search')}
              </div>
              <div className="smtcmp-chat-settings-row-inline">
                <div className="smtcmp-chat-settings-label">
                  {t('chat.conversationSettings.useVaultSearch', 'RAG search')}
                </div>
                <div className="smtcmp-segmented">
                  <button
                    type="button"
                    className={value.useVaultSearch === true ? 'active' : ''}
                    onClick={() => updateVaultSearch(true)}
                  >
                    {t('common.on', 'On')}
                  </button>
                  <button
                    type="button"
                    className={value.useVaultSearch === false ? 'active' : ''}
                    onClick={() => updateVaultSearch(false)}
                  >
                    {t('common.off', 'Off')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
