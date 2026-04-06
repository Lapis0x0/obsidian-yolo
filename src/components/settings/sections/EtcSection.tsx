import { App, Notice, normalizePath } from 'obsidian'
import { useCallback, useEffect, useState } from 'react'

import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_CHAT_MODEL_ID,
  DEFAULT_CHAT_TITLE_MODEL_ID,
  DEFAULT_EMBEDDING_MODELS,
  DEFAULT_PROVIDERS,
} from '../../../constants'
import { ensureJsonDbRootDir } from '../../../core/paths/yoloManagedData'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ChatManager } from '../../../database/json/chat/ChatManager'
import { clearAllPromptSnapshotStores } from '../../../database/json/chat/promptSnapshotStore'
import { clearAllEditReviewSnapshotStores } from '../../../database/json/chat/editReviewSnapshotStore'
import { clearAllTimelineHeightCacheStores } from '../../../database/json/chat/timelineHeightCacheStore'
import { CHAT_DIR } from '../../../database/json/constants'
import SmartComposerPlugin from '../../../main'
import { smartComposerSettingsSchema } from '../../../settings/schema/setting.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ConfirmModal } from '../../modals/ConfirmModal'

type EtcSectionProps = {
  app: App
  plugin: SmartComposerPlugin
  className?: string
}

type StorageUsage = {
  chatHistoryBytes: number | null
  chatSnapshotBytes: number | null
}

const CHAT_SNAPSHOT_DIR = 'chat_snapshots'
const EDIT_REVIEW_SNAPSHOT_DIR = 'edit_review_snapshots'
const TIMELINE_HEIGHT_CACHE_DIR = 'timeline_height_cache'

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const digits = value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

const getPathSize = async (app: App, path: string): Promise<number> => {
  if (!(await app.vault.adapter.exists(path))) {
    return 0
  }

  const stat = await app.vault.adapter.stat(path)
  if (!stat) {
    return 0
  }

  if (stat.type === 'file') {
    return stat.size
  }

  const listing = await app.vault.adapter.list(path)
  const childSizes = await Promise.all([
    ...listing.files.map(async (filePath) => {
      const fileStat = await app.vault.adapter.stat(filePath)
      return fileStat?.size ?? 0
    }),
    ...listing.folders.map((folderPath) => getPathSize(app, folderPath)),
  ])

  return childSizes.reduce((sum, size) => sum + size, 0)
}

const loadStorageUsage = async (
  app: App,
  settings: Parameters<typeof ensureJsonDbRootDir>[1],
): Promise<StorageUsage> => {
  const rootDir = await ensureJsonDbRootDir(app, settings)
  const chatDir = normalizePath(`${rootDir}/${CHAT_DIR}`)

  const [
    chatHistoryBytes,
    promptSnapshotBytes,
    editReviewSnapshotBytes,
    timelineHeightCacheBytes,
  ] =
    await Promise.all([
      getPathSize(app, chatDir),
      getPathSize(app, normalizePath(`${chatDir}/${CHAT_SNAPSHOT_DIR}`)),
      getPathSize(app, normalizePath(`${chatDir}/${EDIT_REVIEW_SNAPSHOT_DIR}`)),
      getPathSize(app, normalizePath(`${chatDir}/${TIMELINE_HEIGHT_CACHE_DIR}`)),
    ])

  return {
    chatHistoryBytes: Math.max(
      0,
      chatHistoryBytes -
        promptSnapshotBytes -
        editReviewSnapshotBytes -
        timelineHeightCacheBytes,
    ),
    chatSnapshotBytes:
      promptSnapshotBytes + editReviewSnapshotBytes + timelineHeightCacheBytes,
  }
}

const StorageBadge = ({ value }: { value: number | null }) => {
  const { t } = useLanguage()

  return (
    <span className="smtcmp-setting-size-badge">
      {value === null ? t('common.loading', '加载中...') : formatBytes(value)}
    </span>
  )
}

export function EtcSection({ app, className }: EtcSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const yoloBaseDir = settings.yolo?.baseDir ?? 'YOLO'
  const [storageUsage, setStorageUsage] = useState<StorageUsage>({
    chatHistoryBytes: null,
    chatSnapshotBytes: null,
  })
  const [yoloBaseDirInput, setYoloBaseDirInput] = useState(yoloBaseDir)

  useEffect(() => {
    setYoloBaseDirInput(yoloBaseDir)
  }, [yoloBaseDir])

  const refreshStorageUsage = useCallback(() => {
    let cancelled = false

    void loadStorageUsage(app, settings)
      .then((nextUsage) => {
        if (!cancelled) {
          setStorageUsage(nextUsage)
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to load storage usage', error)
        if (!cancelled) {
          setStorageUsage({
            chatHistoryBytes: 0,
            chatSnapshotBytes: 0,
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [app, settings])

  useEffect(() => refreshStorageUsage(), [refreshStorageUsage])

  const handleYoloBaseDirBlur = (value: string) => {
    const normalized = normalizePath(value.trim()).replace(/^\/+/, '') || 'YOLO'
    setYoloBaseDirInput(normalized)
    if (normalized === yoloBaseDir) return

    void setSettings({
      ...settings,
      yolo: {
        ...(settings.yolo ?? { baseDir: 'YOLO' }),
        baseDir: normalized,
      },
    })
  }

  const handleResetSettings = () => {
    new ConfirmModal(app, {
      title: t('settings.etc.resetSettings'),
      message: t('settings.etc.resetSettingsConfirm'),
      ctaText: t('settings.etc.reset'),
      onConfirm: () => {
        void (async () => {
          const defaultSettings = smartComposerSettingsSchema.parse({})
          await setSettings(defaultSettings)
          new Notice(t('settings.etc.resetSettingsSuccess'))
        })().catch((error: unknown) => {
          console.error('Failed to reset settings', error)
          new Notice(t('common.error'))
        })
      },
    }).open()
  }

  const handleClearChatHistory = () => {
    new ConfirmModal(app, {
      title: t('settings.etc.clearChatHistory'),
      message: t('settings.etc.clearChatHistoryConfirm'),
      ctaText: t('common.clear'),
      onConfirm: () => {
        void (async () => {
          const manager = new ChatManager(app, settings)
          const list = await manager.listChats()
          for (const meta of list) {
            await manager.deleteChat(meta.id)
          }
          const nextUsage = await loadStorageUsage(app, settings)
          setStorageUsage(nextUsage)
          // Notify UI hooks (useChatHistory) to refresh chat list immediately
          window.dispatchEvent(new Event('smtcmp:chat-history-cleared'))
          new Notice(t('settings.etc.clearChatHistorySuccess'))
        })().catch((error: unknown) => {
          console.error('Failed to clear chat history', error)
          new Notice(t('common.error'))
        })
      },
    }).open()
  }

  const handleResetProviders = () => {
    new ConfirmModal(app, {
      title: t('settings.etc.resetProviders'),
      message: t('settings.etc.resetProvidersConfirm'),
      ctaText: t('settings.etc.reset'),
      onConfirm: () => {
        void (async () => {
          const defaultChatModelId =
            DEFAULT_CHAT_MODELS.find((v) => v.id === DEFAULT_CHAT_MODEL_ID)
              ?.id ?? DEFAULT_CHAT_MODELS[0].id
          const defaultChatTitleModelId =
            DEFAULT_CHAT_MODELS.find(
              (v) => v.id === DEFAULT_CHAT_TITLE_MODEL_ID,
            )?.id ?? DEFAULT_CHAT_MODELS[0].id
          const defaultEmbeddingModelId = DEFAULT_EMBEDDING_MODELS[0].id

          await setSettings({
            ...settings,
            providers: [...DEFAULT_PROVIDERS],
            chatModels: [...DEFAULT_CHAT_MODELS],
            embeddingModels: [...DEFAULT_EMBEDDING_MODELS],
            chatModelId: defaultChatModelId,
            chatTitleModelId: defaultChatTitleModelId,
            embeddingModelId: defaultEmbeddingModelId,
          })
          new Notice(t('settings.etc.resetProvidersSuccess'))
        })().catch((error: unknown) => {
          console.error('Failed to reset providers', error)
          new Notice(t('common.error'))
        })
      },
    }).open()
  }

  const handleClearChatSnapshots = () => {
    new ConfirmModal(app, {
      title: t('settings.etc.clearChatSnapshots'),
      message: t('settings.etc.clearChatSnapshotsConfirm'),
      ctaText: t('common.clear'),
      onConfirm: () => {
        void (async () => {
          await clearAllPromptSnapshotStores(app, settings)
          await clearAllEditReviewSnapshotStores(app, settings)
          await clearAllTimelineHeightCacheStores(app, settings)
          const nextUsage = await loadStorageUsage(app, settings)
          setStorageUsage(nextUsage)
          new Notice(t('settings.etc.clearChatSnapshotsSuccess'))
        })().catch((error: unknown) => {
          console.error('Failed to clear chat snapshots', error)
          new Notice(t('common.error'))
        })
      },
    }).open()
  }

  const handleResetAgents = () => {
    new ConfirmModal(app, {
      title: t('settings.etc.resetAgents'),
      message: t('settings.etc.resetAgentsConfirm'),
      ctaText: t('settings.etc.reset'),
      onConfirm: () => {
        void (async () => {
          await setSettings({
            ...settings,
            assistants: [],
            currentAssistantId: undefined,
            quickAskAssistantId: undefined,
          })
          new Notice(t('settings.etc.resetAgentsSuccess'))
        })().catch((error: unknown) => {
          console.error('Failed to reset agents', error)
          new Notice(t('common.error'))
        })
      },
    }).open()
  }

  return (
    <div
      className={['smtcmp-settings-section', className]
        .filter(Boolean)
        .join(' ')}
    >
      <section className="smtcmp-settings-block">
        <div className="smtcmp-settings-block-head">
          <div className="smtcmp-settings-block-head-title-row">
            <div className="smtcmp-settings-sub-header smtcmp-settings-block-title">
              {t('settings.etc.maintenanceSectionTitle', 'Maintenance')}
            </div>
          </div>
        </div>

        <div className="smtcmp-settings-block-content">
          <ObsidianSetting
            name={t('settings.etc.yoloBaseDir', 'YOLO 根目录')}
            desc={t(
              'settings.etc.yoloBaseDirDesc',
              '用于存放 YOLO 管理文件的库内相对目录（例如：Config/YOLO）。技能将从 {path} 加载。',
            ).replace('{path}', `${yoloBaseDir}/skills`)}
            className="smtcmp-settings-card"
          >
            <ObsidianTextInput
              value={yoloBaseDirInput}
              placeholder={t('settings.etc.yoloBaseDirPlaceholder', 'YOLO')}
              onChange={setYoloBaseDirInput}
              onBlur={handleYoloBaseDirBlur}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.etc.logModelRequestContext')}
            desc={t('settings.etc.logModelRequestContextDesc')}
            className="smtcmp-settings-card"
          >
            <ObsidianToggle
              value={settings.debug?.logModelRequestContext ?? false}
              onChange={(value) => {
                void setSettings({
                  ...settings,
                  debug: {
                    ...settings.debug,
                    logModelRequestContext: value,
                  },
                })
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.etc.clearChatHistory')}
            nameExtra={<StorageBadge value={storageUsage.chatHistoryBytes} />}
            desc={t('settings.etc.clearChatHistoryDesc')}
            className="smtcmp-settings-card"
          >
            <ObsidianButton
              text={t('common.clear')}
              warning
              onClick={handleClearChatHistory}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.etc.clearChatSnapshots')}
            nameExtra={<StorageBadge value={storageUsage.chatSnapshotBytes} />}
            desc={t('settings.etc.clearChatSnapshotsDesc')}
            className="smtcmp-settings-card"
          >
            <ObsidianButton
              text={t('common.clear')}
              warning
              onClick={handleClearChatSnapshots}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.etc.resetProviders')}
            desc={t('settings.etc.resetProvidersDesc')}
            className="smtcmp-settings-card"
          >
            <ObsidianButton
              text={t('settings.etc.reset')}
              warning
              onClick={handleResetProviders}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.etc.resetAgents')}
            desc={t('settings.etc.resetAgentsDesc')}
            className="smtcmp-settings-card"
          >
            <ObsidianButton
              text={t('settings.etc.reset')}
              warning
              onClick={handleResetAgents}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.etc.resetSettings')}
            desc={t('settings.etc.resetSettingsDesc')}
            className="smtcmp-settings-card"
          >
            <ObsidianButton
              text={t('settings.etc.reset')}
              warning
              onClick={handleResetSettings}
            />
          </ObsidianSetting>
        </div>
      </section>
    </div>
  )
}
