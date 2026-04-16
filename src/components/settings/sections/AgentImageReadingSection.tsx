import { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'

const IMAGE_COMPRESSION_QUALITY_MIN = 1
const IMAGE_COMPRESSION_QUALITY_MAX = 100
const IMAGE_COMPRESSION_QUALITY_FALLBACK = 85

export function AgentImageReadingSection() {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

  const isImageReadingEnabled =
    settings.chatOptions.imageReadingEnabled ?? true

  const isCompressionEnabled =
    settings.chatOptions.imageCompressionEnabled ?? true

  const [qualityInput, setQualityInput] = useState(
    String(
      settings.chatOptions.imageCompressionQuality ??
        IMAGE_COMPRESSION_QUALITY_FALLBACK,
    ),
  )

  useEffect(() => {
    setQualityInput(
      String(
        settings.chatOptions.imageCompressionQuality ??
          IMAGE_COMPRESSION_QUALITY_FALLBACK,
      ),
    )
  }, [settings.chatOptions.imageCompressionQuality])

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
        name={t('settings.agent.imageReadingEnabled')}
        desc={t('settings.agent.imageReadingEnabledDesc')}
        className="smtcmp-settings-card"
      >
        <ObsidianToggle
          value={isImageReadingEnabled}
          onChange={(value) => {
            updateChatOptions(
              { imageReadingEnabled: value },
              'imageReadingEnabled',
            )
          }}
        />
      </ObsidianSetting>

      {isImageReadingEnabled && (
        <>
          <ObsidianSetting
            name={t('settings.agent.imageCompressionEnabled')}
            desc={t('settings.agent.imageCompressionEnabledDesc')}
            className="smtcmp-settings-card"
          >
            <ObsidianToggle
              value={isCompressionEnabled}
              onChange={(value) => {
                updateChatOptions(
                  { imageCompressionEnabled: value },
                  'imageCompressionEnabled',
                )
              }}
            />
          </ObsidianSetting>

          {isCompressionEnabled && (
            <ObsidianSetting
              name={t('settings.agent.imageCompressionQuality')}
              desc={t('settings.agent.imageCompressionQualityDesc')}
              className="smtcmp-settings-card"
            >
              <ObsidianTextInput
                value={qualityInput}
                type="number"
                onChange={(value) => {
                  setQualityInput(value)
                }}
                onBlur={(value) => {
                  const parsed = Number.parseInt(value, 10)
                  if (Number.isNaN(parsed)) {
                    setQualityInput(
                      String(
                        settings.chatOptions.imageCompressionQuality ??
                          IMAGE_COMPRESSION_QUALITY_FALLBACK,
                      ),
                    )
                    return
                  }
                  const clamped = Math.max(
                    IMAGE_COMPRESSION_QUALITY_MIN,
                    Math.min(IMAGE_COMPRESSION_QUALITY_MAX, parsed),
                  )
                  setQualityInput(String(clamped))
                  if (
                    clamped !== settings.chatOptions.imageCompressionQuality
                  ) {
                    updateChatOptions(
                      { imageCompressionQuality: clamped },
                      'imageCompressionQuality',
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
