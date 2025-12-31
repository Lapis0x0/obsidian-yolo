import { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

export function ChatPreferencesSection() {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const [maxAutoIterationsInput, setMaxAutoIterationsInput] = useState(
    settings.chatOptions.maxAutoIterations.toString(),
  )
  const [maxContextMessagesInput, setMaxContextMessagesInput] = useState(
    (settings.chatOptions.maxContextMessages ?? 32).toString(),
  )

  useEffect(() => {
    setMaxAutoIterationsInput(settings.chatOptions.maxAutoIterations.toString())
  }, [settings.chatOptions.maxAutoIterations])

  useEffect(() => {
    setMaxContextMessagesInput(
      (settings.chatOptions.maxContextMessages ?? 32).toString(),
    )
  }, [settings.chatOptions.maxContextMessages])

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

  const parseIntegerInput = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    if (!/^\d+$/.test(trimmed)) return null
    return parseInt(trimmed, 10)
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
        name={t('settings.chatPreferences.enableTools')}
        desc={t('settings.chatPreferences.enableToolsDesc')}
      >
        <ObsidianToggle
          value={settings.chatOptions.enableTools}
          onChange={(value) => {
            updateChatOptions(
              {
                enableTools: value,
              },
              'enableTools',
            )
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.chatPreferences.maxAutoIterations')}
        desc={t('settings.chatPreferences.maxAutoIterationsDesc')}
      >
        <ObsidianTextInput
          value={maxAutoIterationsInput}
          onChange={(value) => {
            setMaxAutoIterationsInput(value)
            const parsedValue = parseIntegerInput(value)
            if (parsedValue === null || parsedValue < 1) return
            updateChatOptions(
              {
                maxAutoIterations: parsedValue,
              },
              'maxAutoIterations',
            )
          }}
          onBlur={() => {
            const parsedValue = parseIntegerInput(maxAutoIterationsInput)
            if (parsedValue === null || parsedValue < 1) {
              setMaxAutoIterationsInput(
                settings.chatOptions.maxAutoIterations.toString(),
              )
            }
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.chatPreferences.maxContextMessages')}
        desc={t('settings.chatPreferences.maxContextMessagesDesc')}
      >
        <ObsidianTextInput
          value={maxContextMessagesInput}
          onChange={(value) => {
            setMaxContextMessagesInput(value)
            const parsedValue = parseIntegerInput(value)
            if (parsedValue === null || parsedValue < 0) return
            updateChatOptions(
              {
                maxContextMessages: parsedValue,
              },
              'maxContextMessages',
            )
          }}
          onBlur={() => {
            const parsedValue = parseIntegerInput(maxContextMessagesInput)
            if (parsedValue === null || parsedValue < 0) {
              setMaxContextMessagesInput(
                (settings.chatOptions.maxContextMessages ?? 32).toString(),
              )
            }
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.chatPreferences.defaultTemperature')}
        desc={t('settings.chatPreferences.defaultTemperatureDesc')}
      >
        <ObsidianTextInput
          value={settings.chatOptions.defaultTemperature?.toString() ?? ''}
          placeholder={t('common.default')}
          onChange={(value) => {
            if (value.trim() === '') {
              updateChatOptions(
                {
                  defaultTemperature: undefined,
                },
                'defaultTemperature (reset)',
              )
              return
            }
            const parsedValue = parseFloat(value)
            if (isNaN(parsedValue) || parsedValue < 0 || parsedValue > 2) {
              return
            }
            updateChatOptions(
              {
                defaultTemperature: parsedValue,
              },
              'defaultTemperature',
            )
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.chatPreferences.defaultTopP')}
        desc={t('settings.chatPreferences.defaultTopPDesc')}
      >
        <ObsidianTextInput
          value={settings.chatOptions.defaultTopP?.toString() ?? ''}
          placeholder={t('common.default')}
          onChange={(value) => {
            if (value.trim() === '') {
              updateChatOptions(
                {
                  defaultTopP: undefined,
                },
                'defaultTopP (reset)',
              )
              return
            }
            const parsedValue = parseFloat(value)
            if (isNaN(parsedValue) || parsedValue < 0 || parsedValue > 1) {
              return
            }
            updateChatOptions(
              {
                defaultTopP: parsedValue,
              },
              'defaultTopP',
            )
          }}
        />
      </ObsidianSetting>
    </div>
  )
}
