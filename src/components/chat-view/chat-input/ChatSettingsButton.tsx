import * as Popover from '@radix-ui/react-popover'
import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ChatModel } from '../../../types/chat-model.types'
import { ConversationOverrideSettings } from '../../../types/conversation-settings.types'

export default function ChatSettingsButton({
  overrides,
  onChange,
  currentModel,
}: {
  overrides?: ConversationOverrideSettings | null
  onChange?: (overrides: ConversationOverrideSettings) => void
  currentModel?: ChatModel
}) {
  const { t } = useLanguage()
  const { settings } = useSettings()
  const value = useMemo<ConversationOverrideSettings>(() => {
    return {
      temperature: overrides?.temperature ?? null,
      top_p: overrides?.top_p ?? null,
      maxContextMessages: overrides?.maxContextMessages ?? null,
      // Default: streaming ON by default unless user explicitly turns it off
      stream: overrides?.stream ?? true,
      // Default: RAG (vault search) OFF by default unless user explicitly turns it on
      useVaultSearch: overrides?.useVaultSearch ?? false,
      // Default: Web search and URL context OFF by default
      useWebSearch: overrides?.useWebSearch ?? false,
      useUrlContext: overrides?.useUrlContext ?? false,
    }
  }, [overrides])

  // Check if current model supports Gemini tools
  const hasGeminiTools = (() => {
    if (!currentModel) {
      return false
    }
    if (currentModel.providerType === 'gemini') {
      return currentModel.toolType === 'gemini'
    }
    if (currentModel.providerType === 'openai-compatible') {
      return currentModel.toolType === 'gemini'
    }
    return false
  })()

  const update = (patch: Partial<ConversationOverrideSettings>) => {
    const next = { ...value, ...patch }
    onChange?.(next)
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

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(onResize)
      ro.observe(wrapper)
      return () => ro.disconnect()
    } else {
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
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
              {t('chat.conversationSettings.chatMemory', 'Chat memory')}
            </div>
            <div className="smtcmp-chat-settings-row2">
              <div className="smtcmp-chat-settings-label">
                {t('chat.conversationSettings.maxContext', 'Max context')}
              </div>
              <input
                type="number"
                className="smtcmp-chat-settings-input smtcmp-number-pill"
                min={0}
                max={256}
                step={1}
                placeholder={settings.chatOptions.maxContextMessages.toString()}
                value={value.maxContextMessages ?? ''}
                onChange={(e) =>
                  update({
                    maxContextMessages:
                      e.currentTarget.value === ''
                        ? null
                        : Number(e.currentTarget.value),
                  })
                }
              />
            </div>
          </div>

          <div className="smtcmp-chat-settings-section">
            <div className="smtcmp-chat-settings-section-title">
              {t('chat.conversationSettings.sampling', 'Sampling parameters')}
            </div>
            <div className="smtcmp-chat-settings-row2">
              <div className="smtcmp-chat-settings-label">
                {t('chat.conversationSettings.temperature', 'Temperature')}
              </div>
              <input
                type="number"
                className="smtcmp-chat-settings-input smtcmp-number-pill"
                min={0}
                max={2}
                step={0.1}
                placeholder={
                  t('common.modelDefault', 'Model default')
                }
                value={value.temperature ?? ''}
                onChange={(e) =>
                  update({
                    temperature:
                      e.currentTarget.value === ''
                        ? null
                        : Number(e.currentTarget.value),
                  })
                }
              />
            </div>

            <div className="smtcmp-chat-settings-row2">
              <div className="smtcmp-chat-settings-label">
                {t('chat.conversationSettings.topP', 'Top P')}
              </div>
              <input
                type="number"
                className="smtcmp-chat-settings-input smtcmp-number-pill"
                min={0}
                max={1}
                step={0.01}
                placeholder={
                  t('common.modelDefault', 'Model default')
                }
                value={value.top_p ?? ''}
                onChange={(e) =>
                  update({
                    top_p:
                      e.currentTarget.value === ''
                        ? null
                        : Number(e.currentTarget.value),
                  })
                }
              />
            </div>

            <div className="smtcmp-chat-settings-row-inline">
              <div className="smtcmp-chat-settings-label">
                {t('chat.conversationSettings.streaming', 'Streaming')}
              </div>
              <div className="smtcmp-segmented">
                <button
                  className={value.stream === true ? 'active' : ''}
                  onClick={() => update({ stream: true })}
                >
                  {t('common.on', 'On')}
                </button>
                <button
                  className={value.stream === false ? 'active' : ''}
                  onClick={() => update({ stream: false })}
                >
                  {t('common.off', 'Off')}
                </button>
              </div>
            </div>
          </div>

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
                  className={value.useVaultSearch === true ? 'active' : ''}
                  onClick={() => update({ useVaultSearch: true })}
                >
                  {t('common.on', 'On')}
                </button>
                <button
                  className={value.useVaultSearch === false ? 'active' : ''}
                  onClick={() => update({ useVaultSearch: false })}
                >
                  {t('common.off', 'Off')}
                </button>
              </div>
            </div>
          </div>

          {hasGeminiTools && (
            <div className="smtcmp-chat-settings-section">
              <div className="smtcmp-chat-settings-section-title">
                {t('chat.conversationSettings.geminiTools', 'Gemini tools')}
              </div>
              <div className="smtcmp-chat-settings-row-inline">
                <div className="smtcmp-chat-settings-label">
                  {t('chat.conversationSettings.webSearch', 'Web search')}
                </div>
                <div className="smtcmp-segmented">
                  <button
                    className={value.useWebSearch === true ? 'active' : ''}
                    onClick={() => update({ useWebSearch: true })}
                  >
                    {t('common.on', 'On')}
                  </button>
                  <button
                    className={value.useWebSearch === false ? 'active' : ''}
                    onClick={() => update({ useWebSearch: false })}
                  >
                    {t('common.off', 'Off')}
                  </button>
                </div>
              </div>
              <div className="smtcmp-chat-settings-row-inline">
                <div className="smtcmp-chat-settings-label">
                  {t('chat.conversationSettings.urlContext', 'URL context')}
                </div>
                <div className="smtcmp-segmented">
                  <button
                    className={value.useUrlContext === true ? 'active' : ''}
                    onClick={() => update({ useUrlContext: true })}
                  >
                    {t('common.on', 'On')}
                  </button>
                  <button
                    className={value.useUrlContext === false ? 'active' : ''}
                    onClick={() => update({ useUrlContext: false })}
                  >
                    {t('common.off', 'Off')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </Popover.Content>
    </Popover.Root>
  )
}
