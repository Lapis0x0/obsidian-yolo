import { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

const HISTORY_ARCHIVE_THRESHOLD_MIN = 20
const HISTORY_ARCHIVE_THRESHOLD_MAX = 500
const HISTORY_ARCHIVE_THRESHOLD_FALLBACK = 50

const AUTO_COMPACTION_TOKENS_MIN = 1
const AUTO_COMPACTION_TOKENS_MAX = 1_000_000
const AUTO_COMPACTION_RATIO_PERCENT_MIN = 1
const AUTO_COMPACTION_RATIO_PERCENT_MAX = 100

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

  const [autoCompactionTokensInput, setAutoCompactionTokensInput] = useState(
    String(settings.chatOptions.autoContextCompactionThresholdTokens ?? 24000),
  )
  const [autoCompactionRatioPercentInput, setAutoCompactionRatioPercentInput] =
    useState(
      String(
        Math.round(
          (settings.chatOptions.autoContextCompactionThresholdRatio ?? 0.8) *
            100,
        ),
      ),
    )

  useEffect(() => {
    setAutoCompactionTokensInput(
      String(settings.chatOptions.autoContextCompactionThresholdTokens ?? 24000),
    )
  }, [settings.chatOptions.autoContextCompactionThresholdTokens])

  useEffect(() => {
    setAutoCompactionRatioPercentInput(
      String(
        Math.round(
          (settings.chatOptions.autoContextCompactionThresholdRatio ?? 0.8) *
            100,
        ),
      ),
    )
  }, [settings.chatOptions.autoContextCompactionThresholdRatio])

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

      <ObsidianSetting
        name={t('settings.chatPreferences.autoContextCompaction')}
        desc={t('settings.chatPreferences.autoContextCompactionDesc')}
        className="smtcmp-settings-card"
      >
        <ObsidianToggle
          value={settings.chatOptions.autoContextCompactionEnabled ?? false}
          onChange={(value) => {
            updateChatOptions(
              {
                autoContextCompactionEnabled: value,
              },
              'autoContextCompactionEnabled',
            )
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.chatPreferences.autoContextCompactionThresholdMode')}
        className="smtcmp-settings-card"
      >
        <ObsidianDropdown
          value={settings.chatOptions.autoContextCompactionThresholdMode ?? 'tokens'}
          options={{
            tokens: t('settings.chatPreferences.autoContextCompactionModeTokens'),
            ratio: t('settings.chatPreferences.autoContextCompactionModeRatio'),
          }}
          onChange={(value) => {
            updateChatOptions(
              {
                autoContextCompactionThresholdMode:
                  value === 'ratio' ? 'ratio' : 'tokens',
              },
              'autoContextCompactionThresholdMode',
            )
          }}
          disabled={!(settings.chatOptions.autoContextCompactionEnabled ?? false)}
        />
      </ObsidianSetting>

      {(settings.chatOptions.autoContextCompactionThresholdMode ?? 'tokens') ===
      'tokens' ? (
        <ObsidianSetting
          name={t(
            'settings.chatPreferences.autoContextCompactionThresholdTokens',
          )}
          desc={t(
            'settings.chatPreferences.autoContextCompactionThresholdTokensDesc',
          )}
          className="smtcmp-settings-card"
        >
          <ObsidianTextInput
            value={autoCompactionTokensInput}
            type="number"
            onChange={(value) => {
              setAutoCompactionTokensInput(value)
            }}
            onBlur={(value) => {
              const parsed = Number.parseInt(value, 10)
              if (Number.isNaN(parsed)) {
                setAutoCompactionTokensInput(
                  String(
                    settings.chatOptions.autoContextCompactionThresholdTokens ??
                      24000,
                  ),
                )
                return
              }
              const clamped = Math.max(
                AUTO_COMPACTION_TOKENS_MIN,
                Math.min(AUTO_COMPACTION_TOKENS_MAX, parsed),
              )
              setAutoCompactionTokensInput(String(clamped))
              if (
                clamped !==
                (settings.chatOptions.autoContextCompactionThresholdTokens ?? 24000)
              ) {
                updateChatOptions(
                  {
                    autoContextCompactionThresholdTokens: clamped,
                  },
                  'autoContextCompactionThresholdTokens',
                )
              }
            }}
          />
        </ObsidianSetting>
      ) : (
        <ObsidianSetting
          name={t(
            'settings.chatPreferences.autoContextCompactionThresholdRatioPercent',
          )}
          desc={t(
            'settings.chatPreferences.autoContextCompactionThresholdRatioPercentDesc',
          )}
          className="smtcmp-settings-card"
        >
          <ObsidianTextInput
            value={autoCompactionRatioPercentInput}
            type="number"
            onChange={(value) => {
              setAutoCompactionRatioPercentInput(value)
            }}
            onBlur={(value) => {
              const parsed = Number.parseInt(value, 10)
              if (Number.isNaN(parsed)) {
                setAutoCompactionRatioPercentInput(
                  String(
                    Math.round(
                      (settings.chatOptions
                        .autoContextCompactionThresholdRatio ?? 0.8) * 100,
                    ),
                  ),
                )
                return
              }
              const clamped = Math.max(
                AUTO_COMPACTION_RATIO_PERCENT_MIN,
                Math.min(AUTO_COMPACTION_RATIO_PERCENT_MAX, parsed),
              )
              setAutoCompactionRatioPercentInput(String(clamped))
              const nextRatio = clamped / 100
              const prevRatio =
                settings.chatOptions.autoContextCompactionThresholdRatio ?? 0.8
              if (nextRatio !== prevRatio) {
                updateChatOptions(
                  {
                    autoContextCompactionThresholdRatio: nextRatio,
                  },
                  'autoContextCompactionThresholdRatio',
                )
              }
            }}
          />
        </ObsidianSetting>
      )}
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
