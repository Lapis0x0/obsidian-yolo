import { App } from 'obsidian'
import React, { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  getYoloBaseDir,
  getYoloSkillsDir,
  normalizeVaultRelativeDir,
} from '../../../core/paths/yoloPaths'
import { selectionHighlightController } from '../../../features/editor/selection-highlight/selectionHighlightController'
import SmartComposerPlugin from '../../../main'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { EtcSection } from '../sections/EtcSection'

type OthersTabProps = {
  app: App
  plugin: SmartComposerPlugin
}

export function OthersTab({ app, plugin }: OthersTabProps) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const yoloBaseDir = getYoloBaseDir(settings)
  const skillsDir = getYoloSkillsDir(settings)
  const [yoloBaseDirInput, setYoloBaseDirInput] = useState(yoloBaseDir)

  useEffect(() => {
    setYoloBaseDirInput(yoloBaseDir)
  }, [yoloBaseDir])

  const handleMentionDisplayModeChange = (value: string) => {
    if (value !== 'inline' && value !== 'badge') return
    void (async () => {
      try {
        await setSettings({
          ...settings,
          chatOptions: {
            ...settings.chatOptions,
            mentionDisplayMode: value,
          },
        })
      } catch (error: unknown) {
        console.error('Failed to update mention display mode', error)
      }
    })()
  }

  const handleChatApplyModeChange = (value: string) => {
    if (value !== 'review-required' && value !== 'direct-apply') return
    void (async () => {
      try {
        await setSettings({
          ...settings,
          chatOptions: {
            ...settings.chatOptions,
            chatApplyMode: value,
          },
        })
      } catch (error: unknown) {
        console.error('Failed to update chat apply mode', error)
      }
    })()
  }

  const handleYoloBaseDirBlur = (value: string) => {
    const normalized = normalizeVaultRelativeDir(value)
    setYoloBaseDirInput(normalized)
    if (normalized === yoloBaseDir) {
      return
    }
    void (async () => {
      try {
        await setSettings({
          ...settings,
          yolo: {
            ...(settings.yolo ?? { baseDir: 'YOLO' }),
            baseDir: normalized,
          },
        })
      } catch (error: unknown) {
        console.error('Failed to update YOLO base dir', error)
      }
    })()
  }

  const handlePersistSelectionHighlightChange = (value: boolean) => {
    void (async () => {
      try {
        await setSettings({
          ...settings,
          continuationOptions: {
            ...settings.continuationOptions,
            persistSelectionHighlight: value,
          },
        })
        if (!value) {
          selectionHighlightController.clearHighlight()
        }
      } catch (error: unknown) {
        console.error('Failed to update selection highlight setting', error)
      }
    })()
  }

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
        console.error('Failed to update task completed notification setting', error)
      }
    })()
  }

  return (
    <>
      <div className="smtcmp-settings-section">
        <ObsidianSetting
          name={t('settings.supportSmartComposer.name')}
          desc={t('settings.supportSmartComposer.desc')}
          heading
          className="smtcmp-settings-support-smart-composer"
        >
          <ObsidianButton
            text={t('settings.supportSmartComposer.buyMeACoffee')}
            onClick={() =>
              window.open('https://afdian.com/a/lapis0x0', '_blank')
            }
            cta
          />
        </ObsidianSetting>
        <ObsidianSetting
          name={t('settings.etc.yoloBaseDir', 'YOLO 根目录')}
          desc={t(
            'settings.etc.yoloBaseDirDesc',
            '用于存放 YOLO 管理文件的库内相对目录（例如：Config/YOLO）。技能将从 {path} 加载。',
          ).replace('{path}', skillsDir)}
        >
          <ObsidianTextInput
            value={yoloBaseDirInput}
            placeholder={t('settings.etc.yoloBaseDirPlaceholder', 'YOLO')}
            onChange={setYoloBaseDirInput}
            onBlur={handleYoloBaseDirBlur}
          />
        </ObsidianSetting>
        <ObsidianSetting
          name={t('settings.etc.mentionDisplayMode', '引用内容显示位置')}
          desc={t(
            'settings.etc.mentionDisplayModeDesc',
            '选择 @ 文件引用和 / 技能选择是在输入框内显示，还是在输入框顶部以徽章显示。',
          )}
        >
          <ObsidianDropdown
            value={settings.chatOptions.mentionDisplayMode ?? 'inline'}
            options={{
              inline: t('settings.etc.mentionDisplayModeInline', '输入框内'),
              badge: t('settings.etc.mentionDisplayModeBadge', '顶部徽章'),
            }}
            onChange={handleMentionDisplayModeChange}
          />
        </ObsidianSetting>
        <ObsidianSetting
          name={t('settings.etc.chatApplyMode', 'Chat 应用修改方式')}
          desc={t(
            'settings.etc.chatApplyModeDesc',
            '仅影响 Chat 侧边栏中的“应用”。可选择先进入内联审阅，或直接写入文件。关闭审阅后，点击应用将不再需要二次审批。',
          )}
        >
          <ObsidianDropdown
            value={settings.chatOptions.chatApplyMode ?? 'review-required'}
            options={{
              'review-required': t(
                'settings.etc.chatApplyModeReviewRequired',
                '先审阅后应用',
              ),
              'direct-apply': t(
                'settings.etc.chatApplyModeDirectApply',
                '直接写入文件',
              ),
            }}
            onChange={handleChatApplyModeChange}
          />
        </ObsidianSetting>
        <ObsidianSetting
          name={t('settings.etc.persistSelectionHighlight', '保留选区块高亮')}
          desc={t(
            'settings.etc.persistSelectionHighlightDesc',
            '在侧边栏 Chat 或 Quick Ask 交互时，持续显示编辑器中已选内容的块级高亮。',
          )}
        >
          <ObsidianToggle
            value={
              settings.continuationOptions.persistSelectionHighlight ?? true
            }
            onChange={handlePersistSelectionHighlightChange}
          />
        </ObsidianSetting>
        <section className="smtcmp-models-block">
          <div className="smtcmp-models-block-head">
            <div className="smtcmp-models-block-head-title-row">
              <div className="smtcmp-settings-sub-header smtcmp-models-block-title">
                {t('settings.etc.notifications', '通知提醒')}
              </div>
            </div>
          </div>

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
                      sound: t(
                        'settings.etc.notificationChannelSound',
                        '仅音效',
                      ),
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
                      settings.notificationOptions
                        .notifyOnApprovalRequired ?? true
                    }
                    onChange={handleNotifyOnApprovalRequiredChange}
                  />
                </ObsidianSetting>
                <ObsidianSetting
                  name={t(
                    'settings.etc.notificationTaskCompleted',
                    '任务结束时提醒',
                  )}
                  desc={t(
                    'settings.etc.notificationTaskCompletedDesc',
                    '当当前 Agent 任务结束且不再等待审批时发出提醒。',
                  )}
                  className="smtcmp-models-select-card"
                >
                  <ObsidianToggle
                    value={
                      settings.notificationOptions.notifyOnTaskCompleted ?? true
                    }
                    onChange={handleNotifyOnTaskCompletedChange}
                  />
                </ObsidianSetting>
              </>
            )}
          </div>
        </section>
      </div>

      <EtcSection app={app} plugin={plugin} />
    </>
  )
}
