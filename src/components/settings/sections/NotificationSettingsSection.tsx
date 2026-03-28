import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianToggle } from '../../common/ObsidianToggle'

export function NotificationSettingsSection() {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()

  const handleNotificationEnabledChange = (value: boolean) => {
    void (async () => {
      try {
        await setSettings({
          ...settings,
          notificationOptions: {
            ...settings.notificationOptions,
            enabled: value,
          },
        })
      } catch (error: unknown) {
        console.error('Failed to update notification enabled setting', error)
      }
    })()
  }

  const handleNotificationChannelChange = (value: string) => {
    if (value !== 'sound' && value !== 'system' && value !== 'both') {
      return
    }
    void (async () => {
      try {
        await setSettings({
          ...settings,
          notificationOptions: {
            ...settings.notificationOptions,
            channel: value,
          },
        })
      } catch (error: unknown) {
        console.error('Failed to update notification channel setting', error)
      }
    })()
  }

  const handleNotificationTimingChange = (value: string) => {
    if (value !== 'always' && value !== 'when-unfocused') {
      return
    }
    void (async () => {
      try {
        await setSettings({
          ...settings,
          notificationOptions: {
            ...settings.notificationOptions,
            timing: value,
          },
        })
      } catch (error: unknown) {
        console.error('Failed to update notification timing setting', error)
      }
    })()
  }

  const handleNotifyOnApprovalRequiredChange = (value: boolean) => {
    void (async () => {
      try {
        await setSettings({
          ...settings,
          notificationOptions: {
            ...settings.notificationOptions,
            notifyOnApprovalRequired: value,
          },
        })
      } catch (error: unknown) {
        console.error(
          'Failed to update approval required notification setting',
          error,
        )
      }
    })()
  }

  const handleNotifyOnTaskCompletedChange = (value: boolean) => {
    void (async () => {
      try {
        await setSettings({
          ...settings,
          notificationOptions: {
            ...settings.notificationOptions,
            notifyOnTaskCompleted: value,
          },
        })
      } catch (error: unknown) {
        console.error(
          'Failed to update task completed notification setting',
          error,
        )
      }
    })()
  }

  return (
    <div className="smtcmp-models-block-content">
      <ObsidianSetting
        name={t('settings.etc.notificationsEnabled', '启用通知')}
        desc={t(
          'settings.etc.notificationsEnabledDesc',
          '为 Agent 任务开启或关闭提醒。',
        )}
        className="smtcmp-models-select-card"
      >
        <ObsidianToggle
          value={settings.notificationOptions.enabled ?? false}
          onChange={handleNotificationEnabledChange}
        />
      </ObsidianSetting>
      {settings.notificationOptions.enabled && (
        <>
          <ObsidianSetting
            name={t('settings.etc.notificationChannel', '通知方式')}
            desc={t(
              'settings.etc.notificationChannelDesc',
              '选择使用音效、系统通知，或同时使用两者。',
            )}
            className="smtcmp-models-select-card"
          >
            <ObsidianDropdown
              value={settings.notificationOptions.channel ?? 'sound'}
              options={{
                sound: t('settings.etc.notificationChannelSound', '仅音效'),
                system: t(
                  'settings.etc.notificationChannelSystem',
                  '仅系统通知',
                ),
                both: t(
                  'settings.etc.notificationChannelBoth',
                  '音效 + 系统通知',
                ),
              }}
              onChange={handleNotificationChannelChange}
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t('settings.etc.notificationTiming', '提醒时机')}
            desc={t(
              'settings.etc.notificationTimingDesc',
              '选择始终提醒，或仅在 Obsidian 失焦时提醒。',
            )}
            className="smtcmp-models-select-card"
          >
            <ObsidianDropdown
              value={settings.notificationOptions.timing ?? 'when-unfocused'}
              options={{
                always: t('settings.etc.notificationTimingAlways', '始终提醒'),
                'when-unfocused': t(
                  'settings.etc.notificationTimingWhenUnfocused',
                  '仅失焦时提醒',
                ),
              }}
              onChange={handleNotificationTimingChange}
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t(
              'settings.etc.notificationApprovalRequired',
              '需要审批时提醒',
            )}
            desc={t(
              'settings.etc.notificationApprovalRequiredDesc',
              '当 YOLO 暂停并等待你审批工具调用时发出提醒。',
            )}
            className="smtcmp-models-select-card"
          >
            <ObsidianToggle
              value={
                settings.notificationOptions.notifyOnApprovalRequired ?? true
              }
              onChange={handleNotifyOnApprovalRequiredChange}
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t('settings.etc.notificationTaskCompleted', '任务结束时提醒')}
            desc={t(
              'settings.etc.notificationTaskCompletedDesc',
              '当当前 Agent 任务结束且不再等待审批时发出提醒。',
            )}
            className="smtcmp-models-select-card"
          >
            <ObsidianToggle
              value={settings.notificationOptions.notifyOnTaskCompleted ?? true}
              onChange={handleNotifyOnTaskCompletedChange}
            />
          </ObsidianSetting>
        </>
      )}
    </div>
  )
}
