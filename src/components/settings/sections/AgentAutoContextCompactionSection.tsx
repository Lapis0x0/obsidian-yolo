import { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { formatIntegerWithGrouping } from '../../../utils/formatIntegerWithGrouping'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

const AUTO_COMPACTION_TOKENS_MIN = 1
const AUTO_COMPACTION_TOKENS_MAX = 1_000_000
const AUTO_COMPACTION_RATIO_PERCENT_MIN = 1
const AUTO_COMPACTION_RATIO_PERCENT_MAX = 100

export function AgentAutoContextCompactionSection() {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

  const isAutoCompactionEnabled =
    settings.chatOptions.autoContextCompactionEnabled ?? false

  const [autoCompactionTokensInput, setAutoCompactionTokensInput] = useState(
    String(settings.chatOptions.autoContextCompactionThresholdTokens ?? 24000),
  )
  const [
    isAutoCompactionTokensInputFocused,
    setIsAutoCompactionTokensInputFocused,
  ] = useState(false)
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
      String(
        settings.chatOptions.autoContextCompactionThresholdTokens ?? 24000,
      ),
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

  return (
    <>
      <ObsidianSetting
        name={t('settings.agent.autoContextCompaction')}
        desc={t('settings.agent.autoContextCompactionDesc')}
        className="smtcmp-settings-card"
      >
        <ObsidianToggle
          value={isAutoCompactionEnabled}
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

      {isAutoCompactionEnabled && (
        <>
          <ObsidianSetting
            name={t('settings.agent.autoContextCompactionThresholdMode')}
            className="smtcmp-settings-card"
          >
            <ObsidianDropdown
              value={
                settings.chatOptions.autoContextCompactionThresholdMode ??
                'tokens'
              }
              options={{
                tokens: t('settings.agent.autoContextCompactionModeTokens'),
                ratio: t('settings.agent.autoContextCompactionModeRatio'),
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
            />
          </ObsidianSetting>

          {(settings.chatOptions.autoContextCompactionThresholdMode ??
            'tokens') === 'tokens' ? (
            <ObsidianSetting
              name={t('settings.agent.autoContextCompactionThresholdTokens')}
              desc={t(
                'settings.agent.autoContextCompactionThresholdTokensDesc',
              )}
              className="smtcmp-settings-card"
            >
              <ObsidianTextInput
                value={
                  isAutoCompactionTokensInputFocused
                    ? autoCompactionTokensInput
                    : formatIntegerWithGrouping(autoCompactionTokensInput)
                }
                type="text"
                inputMode="numeric"
                onFocus={() => {
                  setIsAutoCompactionTokensInputFocused(true)
                }}
                onChange={(value) => {
                  const digitsOnly = value.replace(/\D/g, '')
                  setAutoCompactionTokensInput(digitsOnly)
                }}
                onBlur={(value) => {
                  setIsAutoCompactionTokensInputFocused(false)
                  const digitsOnly = value.replace(/\D/g, '')
                  const parsed = Number.parseInt(digitsOnly, 10)
                  if (Number.isNaN(parsed) || digitsOnly === '') {
                    setAutoCompactionTokensInput(
                      String(
                        settings.chatOptions
                          .autoContextCompactionThresholdTokens ?? 24000,
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
                    (settings.chatOptions
                      .autoContextCompactionThresholdTokens ?? 24000)
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
                'settings.agent.autoContextCompactionThresholdRatioPercent',
              )}
              desc={t(
                'settings.agent.autoContextCompactionThresholdRatioPercentDesc',
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
                    settings.chatOptions.autoContextCompactionThresholdRatio ??
                    0.8
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
      )}
    </>
  )
}
