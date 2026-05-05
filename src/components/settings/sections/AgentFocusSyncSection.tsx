import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianToggle } from '../../common/ObsidianToggle'

export function AgentFocusSyncSection() {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

  const handleChange = (value: boolean) => {
    void (async () => {
      try {
        await setSettings({
          ...settings,
          chatOptions: {
            ...settings.chatOptions,
            includeCurrentFileContent: value,
          },
        })
      } catch (error) {
        console.error('Failed to update focus sync setting', error)
      }
    })()
  }

  return (
    <ObsidianSetting
      name={t('settings.agent.focusSyncTitle')}
      desc={t('settings.agent.focusSyncDesc')}
      className="smtcmp-settings-card yolo-focus-sync-card"
    >
      <ObsidianToggle
        value={settings.chatOptions.includeCurrentFileContent}
        onChange={handleChange}
      />
    </ObsidianSetting>
  )
}
