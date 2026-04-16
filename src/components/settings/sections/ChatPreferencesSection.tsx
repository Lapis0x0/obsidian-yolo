import { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { FontScaleSlider } from './FontScaleSlider'

const HISTORY_ARCHIVE_THRESHOLD_MIN = 20
const HISTORY_ARCHIVE_THRESHOLD_MAX = 500
const HISTORY_ARCHIVE_THRESHOLD_FALLBACK = 50

type ChatPreferencesSectionProps = {
  embedded?: boolean
}

export function ChatPreferencesSection({
  embedded = false,
}: ChatPreferencesSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const [historyArchiveThresholdInput, setHistoryArchiveThresholdInput] =
    useState(
      String(
        settings.chatOptions.historyArchiveThreshold ??
          HISTORY_ARCHIVE_THRESHOLD_FALLBACK,
      ),
    )

  useEffect(() => {
    setHistoryArchiveThresholdInput(
      String(
        settings.chatOptions.historyArchiveThreshold ??
          HISTORY_ARCHIVE_THRESHOLD_FALLBACK,
      ),
    )
  }, [settings.chatOptions.historyArchiveThreshold])

  const updateChatOptions = (
    patch: Partial<typeof settings.chatOptions>,
    context: string,
  ) => {
    void (async () => {
      try {
        await setSettings({
          ...settings,
          chatOptions: {
            ...settings.chatOptions,
            ...patch,
          },
        })
      } catch (error: unknown) {
        console.error(`Failed to update chat options: ${context}`, error)
      }
    })()
  }

  const settingsContent = (
    <>
      <ObsidianSetting
        name={t('settings.chatPreferences.chatFontScale')}
        desc={t('settings.chatPreferences.chatFontScaleDesc')}
        className="smtcmp-settings-card"
      >
        <FontScaleSlider
          value={settings.chatOptions.chatFontScale ?? 1}
          onChange={(value) => {
            updateChatOptions(
              { chatFontScale: value === 1 ? undefined : value },
              'chatFontScale',
            )
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.chatPreferences.includeCurrentFile')}
        desc={t('settings.chatPreferences.includeCurrentFileDesc')}
        className="smtcmp-settings-card"
      >
        <ObsidianToggle
          value={settings.chatOptions.includeCurrentFileContent}
          onChange={(value) => {
            updateChatOptions(
              {
                includeCurrentFileContent: value,
              },
              'includeCurrentFileContent',
            )
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.chatPreferences.historyArchiveEnabled')}
        desc={t('settings.chatPreferences.historyArchiveEnabledDesc')}
        className="smtcmp-settings-card"
      >
        <ObsidianToggle
          value={settings.chatOptions.historyArchiveEnabled ?? true}
          onChange={(value) => {
            updateChatOptions(
              {
                historyArchiveEnabled: value,
              },
              'historyArchiveEnabled',
            )
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.chatPreferences.historyArchiveThreshold')}
        desc={t('settings.chatPreferences.historyArchiveThresholdDesc')}
        className="smtcmp-settings-card"
      >
        <ObsidianTextInput
          value={historyArchiveThresholdInput}
          type="number"
          onChange={(value) => {
            setHistoryArchiveThresholdInput(value)
          }}
          onBlur={(value) => {
            const parsed = Number.parseInt(value, 10)
            if (Number.isNaN(parsed)) {
              setHistoryArchiveThresholdInput(
                String(
                  settings.chatOptions.historyArchiveThreshold ??
                    HISTORY_ARCHIVE_THRESHOLD_FALLBACK,
                ),
              )
              return
            }
            const clamped = Math.max(
              HISTORY_ARCHIVE_THRESHOLD_MIN,
              Math.min(HISTORY_ARCHIVE_THRESHOLD_MAX, parsed),
            )
            setHistoryArchiveThresholdInput(String(clamped))
            if (clamped !== settings.chatOptions.historyArchiveThreshold) {
              updateChatOptions(
                {
                  historyArchiveThreshold: clamped,
                },
                'historyArchiveThreshold',
              )
            }
          }}
        />
      </ObsidianSetting>
    </>
  )

  if (embedded) return settingsContent

  return (
    <div className="smtcmp-settings-section">
      <section className="smtcmp-settings-block">
        <div className="smtcmp-settings-block-head">
          <div className="smtcmp-settings-block-head-title-row">
            <div className="smtcmp-settings-sub-header smtcmp-settings-block-title">
              {t('settings.chatPreferences.title')}
            </div>
          </div>
        </div>

        <div className="smtcmp-settings-block-content">{settingsContent}</div>
      </section>
    </div>
  )
}
