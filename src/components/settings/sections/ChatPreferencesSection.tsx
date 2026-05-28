import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ObsidianSetting } from '../../common/ObsidianSetting'

import { FontScaleSlider } from './FontScaleSlider'

type ChatPreferencesSectionProps = {
  embedded?: boolean
}

export function ChatPreferencesSection({
  embedded = false,
}: ChatPreferencesSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

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
    <ObsidianSetting
      name={t('settings.chatPreferences.chatFontScale')}
      desc={t('settings.chatPreferences.chatFontScaleDesc')}
      className="yolo-settings-card"
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
  )

  if (embedded) return settingsContent

  return (
    <div className="yolo-settings-section">
      <section className="yolo-settings-block">
        <div className="yolo-settings-block-head">
          <div className="yolo-settings-block-head-title-row">
            <div className="yolo-settings-sub-header yolo-settings-block-title">
              {t('settings.chatPreferences.title')}
            </div>
          </div>
        </div>

        <div className="yolo-settings-block-content">{settingsContent}</div>
      </section>
    </div>
  )
}
