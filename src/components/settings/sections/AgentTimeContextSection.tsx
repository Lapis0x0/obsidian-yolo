import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianToggle } from '../../common/ObsidianToggle'

export function AgentTimeContextSection() {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

  const handleChange = (value: boolean) => {
    void (async () => {
      try {
        await setSettings({
          ...settings,
          timeContextEnabled: value,
        })
      } catch (error) {
        console.error('Failed to update time context setting', error)
      }
    })()
  }

  return (
    <ObsidianSetting
      name={t('settings.agent.timeContextTitle')}
      desc={t('settings.agent.timeContextDesc')}
      className="yolo-settings-card yolo-agent-capability-card"
    >
      <ObsidianToggle
        value={settings.timeContextEnabled}
        onChange={handleChange}
      />
    </ObsidianSetting>
  )
}
