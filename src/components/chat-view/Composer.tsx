import React, { useCallback, useMemo } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { useSettings } from '../../contexts/settings-context'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import { getModelDisplayName } from '../../utils/model-id-utils'
import { ObsidianDropdown } from '../common/ObsidianDropdown'
import { ObsidianTextArea } from '../common/ObsidianTextArea'
import { ObsidianToggle } from '../common/ObsidianToggle'
import { FolderSelectionList } from '../settings/inputs/FolderSelectionList'

type ComposerProps = {
  onNavigateChat?: () => void
}

const Composer: React.FC<ComposerProps> = (_props) => {
  const app = useApp()
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()

  const orderedEnabledModels = useMemo(() => {
    const enabledModels = settings.chatModels.filter(
      ({ enable }) => enable ?? true,
    )
    const providerOrder = settings.providers.map((p) => p.id)
    const providerIdsInModels = Array.from(
      new Set(enabledModels.map((m) => m.providerId)),
    )
    const orderedProviderIds = [
      ...providerOrder.filter((id) => providerIdsInModels.includes(id)),
      ...providerIdsInModels.filter((id) => !providerOrder.includes(id)),
    ]
    return orderedProviderIds.flatMap((pid) =>
      enabledModels.filter((m) => m.providerId === pid),
    )
  }, [settings.chatModels, settings.providers])

  const referenceRuleFolders =
    settings.continuationOptions.referenceRuleFolders ??
    settings.continuationOptions.manualContextFolders ??
    []
  const knowledgeBaseFolders =
    settings.continuationOptions.knowledgeBaseFolders ?? []
  const continuationModelId =
    settings.continuationOptions.continuationModelId ??
    orderedEnabledModels[0]?.id ??
    settings.chatModelId
  const enableSuperContinuation = Boolean(
    settings.continuationOptions.enableSuperContinuation,
  )
  const continuationTemperature = settings.continuationOptions.temperature
  const continuationTopP = settings.continuationOptions.topP
  const continuationStreamEnabled = settings.continuationOptions.stream ?? true
  const continuationUseVaultSearch =
    settings.continuationOptions.useVaultSearch ??
    Boolean(settings.ragOptions.enabled)
  const maxContinuationChars =
    settings.continuationOptions.maxContinuationChars ?? 8000

  const updateContinuationOptions = useCallback(
    (updates: Partial<SmartComposerSettings['continuationOptions']>) => {
      void setSettings({
        ...settings,
        continuationOptions: {
          ...settings.continuationOptions,
          ...updates,
        },
      })
    },
    [setSettings, settings],
  )

  const updateRagEnabled = useCallback(
    (enabled: boolean) => {
      void setSettings({
        ...settings,
        ragOptions: {
          ...settings.ragOptions,
          enabled,
        },
        continuationOptions: {
          ...settings.continuationOptions,
          useVaultSearch: enabled,
        },
      })
    },
    [setSettings, settings],
  )

  return (
    <div className="smtcmp-composer-container">
      <div className="smtcmp-composer-scroll">
        <section className="smtcmp-composer-section">
          <header className="smtcmp-composer-heading">
            <div className="smtcmp-composer-heading-title">
              {t(
                'sidebar.composer.sections.modelWithPrompt.title',
                '模型选择与提示词',
              )}
            </div>
            <div className="smtcmp-composer-heading-desc">
              {t(
                'sidebar.composer.sections.model.desc',
                '选择用于续写任务的模型。',
              )}
            </div>
          </header>
          <div className="smtcmp-composer-option smtcmp-composer-option--model">
            <div className="smtcmp-composer-option-info"></div>
            <div className="smtcmp-composer-option-control">
              <ObsidianDropdown
                value={continuationModelId}
                options={Object.fromEntries(
                  orderedEnabledModels.map((m) => {
                    const provider = settings.providers.find(
                      (p) => p.id === m.providerId,
                    )
                    const baseName =
                      m.name?.trim() || m.model || getModelDisplayName(m.id)
                    const providerSuffix = provider?.id
                      ? ` (${provider.id})`
                      : ''
                    return [m.id, `${baseName}${providerSuffix}`]
                  }),
                )}
                onChange={(value) =>
                  updateContinuationOptions({ continuationModelId: value })
                }
                disabled={!enableSuperContinuation}
              />
            </div>
          </div>

          <div className="smtcmp-composer-option">
            <div className="smtcmp-composer-option-info">
              <div className="smtcmp-composer-option-title">
                {t('sidebar.composer.continuationPrompt', '续写系统提示词')}
              </div>
            </div>
            <div className="smtcmp-composer-option-control smtcmp-composer-option-control--full">
              <ObsidianTextArea
                value={settings.continuationOptions.defaultSystemPrompt ?? ''}
                onChange={(value) =>
                  updateContinuationOptions({ defaultSystemPrompt: value })
                }
                disabled={!enableSuperContinuation}
              />
            </div>
          </div>
        </section>

        <section className="smtcmp-composer-section">
          <header className="smtcmp-composer-heading">
            <div className="smtcmp-composer-heading-title">
              {t('sidebar.composer.sections.parameters.title', '参数设置')}
            </div>
            <div className="smtcmp-composer-heading-desc">
              {t(
                'sidebar.composer.sections.parameters.desc',
                '针对续写行为的核心开关。',
              )}
            </div>
          </header>
          <div className="smtcmp-composer-option">
            <div className="smtcmp-composer-option-info">
              <div className="smtcmp-composer-option-title">
                {t('chat.conversationSettings.temperature', '温度')}
              </div>
            </div>
            <div className="smtcmp-composer-option-control">
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                className="smtcmp-number-pill"
                value={
                  typeof continuationTemperature === 'number'
                    ? continuationTemperature
                    : ''
                }
                placeholder={
                  settings.chatOptions.defaultTemperature?.toString() ??
                  t('common.default', '默认')
                }
                onChange={(event) => {
                  const value = event.currentTarget.value
                  if (value === '') {
                    updateContinuationOptions({ temperature: undefined })
                    return
                  }
                  const parsed = Number(value)
                  if (Number.isNaN(parsed)) return
                  const clamped = Math.min(2, Math.max(0, parsed))
                  updateContinuationOptions({ temperature: clamped })
                }}
              />
            </div>
          </div>

          <div className="smtcmp-composer-option">
            <div className="smtcmp-composer-option-info">
              <div className="smtcmp-composer-option-title">
                {t('chat.conversationSettings.topP', 'Top P')}
              </div>
            </div>
            <div className="smtcmp-composer-option-control">
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                className="smtcmp-number-pill"
                value={
                  typeof continuationTopP === 'number' ? continuationTopP : ''
                }
                placeholder={
                  settings.chatOptions.defaultTopP?.toString() ??
                  t('common.default', '默认')
                }
                onChange={(event) => {
                  const value = event.currentTarget.value
                  if (value === '') {
                    updateContinuationOptions({ topP: undefined })
                    return
                  }
                  const parsed = Number(value)
                  if (Number.isNaN(parsed)) return
                  const clamped = Math.min(1, Math.max(0, parsed))
                  updateContinuationOptions({ topP: clamped })
                }}
              />
            </div>
          </div>

          <div className="smtcmp-composer-option">
            <div className="smtcmp-composer-option-info">
              <div className="smtcmp-composer-option-title">
                {t('sidebar.composer.maxContinuationChars', '续写传入字符数')}
              </div>
            </div>
            <div className="smtcmp-composer-option-control">
              <input
                type="number"
                min={0}
                max={20000}
                step={100}
                className="smtcmp-number-pill"
                value={maxContinuationChars}
                placeholder="8000"
                onChange={(event) => {
                  const raw = event.currentTarget.value
                  if (raw === '') {
                    updateContinuationOptions({
                      maxContinuationChars: undefined,
                    })
                    return
                  }
                  const value = Number(raw)
                  if (Number.isNaN(value)) return
                  const clamped = Math.max(
                    0,
                    Math.min(20000, Math.round(value)),
                  )
                  updateContinuationOptions({
                    maxContinuationChars: clamped,
                  })
                }}
              />
            </div>
          </div>

          <div className="smtcmp-composer-option">
            <div className="smtcmp-composer-option-info">
              <div className="smtcmp-composer-option-title">
                {t('chat.conversationSettings.streaming', '流式输出')}
              </div>
            </div>
            <div className="smtcmp-composer-option-control">
              <ObsidianToggle
                value={continuationStreamEnabled}
                onChange={(value) =>
                  updateContinuationOptions({ stream: value })
                }
              />
            </div>
          </div>
        </section>

        <section className="smtcmp-composer-section">
          <header className="smtcmp-composer-heading">
            <div className="smtcmp-composer-heading-title">
              {t('sidebar.composer.sections.context.title', '上下文管理')}
            </div>
            <div className="smtcmp-composer-heading-desc">
              {t(
                'sidebar.composer.sections.context.desc',
                '定义续写时优先参考的内容来源。',
              )}
            </div>
          </header>
          <div className="smtcmp-composer-context-picker">
            <FolderSelectionList
              app={app}
              vault={app.vault}
              value={referenceRuleFolders}
              onChange={(folders) =>
                updateContinuationOptions({ referenceRuleFolders: folders })
              }
              title={t('sidebar.composer.referenceRulesTitle', '参考规则')}
              placeholder={t(
                'sidebar.composer.referenceRulesPlaceholder',
                '点击选择需要完整注入上下文的文件夹。',
              )}
              allowFiles
            />
          </div>

          <div className="smtcmp-composer-option">
            <div className="smtcmp-composer-option-info">
              <div className="smtcmp-composer-option-title">
                {t('chat.conversationSettings.useVaultSearch', 'RAG 搜索')}
              </div>
            </div>
            <div className="smtcmp-composer-option-control">
              <ObsidianToggle
                value={continuationUseVaultSearch}
                onChange={(value) => updateRagEnabled(value)}
              />
            </div>
          </div>

          {continuationUseVaultSearch ? (
            <div className="smtcmp-composer-context-picker">
              <FolderSelectionList
                app={app}
                vault={app.vault}
                value={knowledgeBaseFolders}
                onChange={(folders) =>
                  updateContinuationOptions({ knowledgeBaseFolders: folders })
                }
                title={t('sidebar.composer.knowledgeBaseTitle', '知识库')}
                placeholder={t(
                  'sidebar.composer.knowledgeBasePlaceholder',
                  '点击选择用作检索范围的文件夹（留空表示全库）。',
                )}
                allowFiles
              />
            </div>
          ) : (
            <div className="smtcmp-composer-hint">
              {t(
                'sidebar.composer.knowledgeBaseHint',
                '开启 RAG 搜索后可限定检索范围。',
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default Composer
