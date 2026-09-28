import { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

const AUTO_COMPACTION_RATIO_PERCENT_MIN = 1
const AUTO_COMPACTION_RATIO_PERCENT_MAX = 100
const DEFAULT_AUTO_COMPACTION_RATIO = 0.9

export function AgentAutoContextCompactionSection() {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

  const isAutoCompactionEnabled =
    settings.chatOptions.autoContextCompactionEnabled ?? true
  const currentRatio =
    settings.chatOptions.autoContextCompactionThresholdRatio ??
    DEFAULT_AUTO_COMPACTION_RATIO

  const [autoCompactionRatioPercentInput, setAutoCompactionRatioPercentInput] =
    useState(String(Math.round(currentRatio * 100)))

  useEffect(() => {
    setAutoCompactionRatioPercentInput(String(Math.round(currentRatio * 100)))
  }, [currentRatio])

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
        className="yolo-settings-card"
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
        <ObsidianSetting
          name={t('settings.agent.autoContextCompactionThresholdRatioPercent')}
          desc={t(
            'settings.agent.autoContextCompactionThresholdRatioPercentDesc',
          )}
          className="yolo-settings-card"
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
                  String(Math.round(currentRatio * 100)),
                )
                return
              }
              const clamped = Math.max(
                AUTO_COMPACTION_RATIO_PERCENT_MIN,
                Math.min(AUTO_COMPACTION_RATIO_PERCENT_MAX, parsed),
              )
              setAutoCompactionRatioPercentInput(String(clamped))
              const nextRatio = clamped / 100
              if (nextRatio !== currentRatio) {
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
}
