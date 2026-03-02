import { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

const HISTORY_ARCHIVE_THRESHOLD_MIN = 20
const HISTORY_ARCHIVE_THRESHOLD_MAX = 500
const HISTORY_ARCHIVE_THRESHOLD_FALLBACK = 50

export function ChatPreferencesSection() {
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

  return (
    <div className="smtcmp-settings-section">
      <div className="smtcmp-settings-header">
        {t('settings.chatPreferences.title')}
      </div>

      <ObsidianSetting
        name={t('settings.chatPreferences.includeCurrentFile')}
        desc={t('settings.chatPreferences.includeCurrentFileDesc')}
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
    </div>
  )
}
