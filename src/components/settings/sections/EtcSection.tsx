import { App, Notice } from 'obsidian'

import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_CHAT_MODEL_ID,
  DEFAULT_CHAT_TITLE_MODEL_ID,
  DEFAULT_EMBEDDING_MODELS,
  DEFAULT_PROVIDERS,
} from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { ChatManager } from '../../../database/json/chat/ChatManager'
import { clearAllPromptSnapshotStores } from '../../../database/json/chat/promptSnapshotStore'
import SmartComposerPlugin from '../../../main'
import { smartComposerSettingsSchema } from '../../../settings/schema/setting.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ConfirmModal } from '../../modals/ConfirmModal'

type EtcSectionProps = {
  app: App
  plugin: SmartComposerPlugin
}

export function EtcSection({ app }: EtcSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

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
          const manager = new ChatManager(app)
          const list = await manager.listChats()
          for (const meta of list) {
            await manager.deleteChat(meta.id)
          }
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
          await clearAllPromptSnapshotStores(app)
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
    <div className="smtcmp-settings-section">
      <div className="smtcmp-settings-header">{t('settings.etc.title')}</div>

      <ObsidianSetting
        name={t('settings.etc.clearChatHistory')}
        desc={t('settings.etc.clearChatHistoryDesc')}
      >
        <ObsidianButton
          text={t('common.clear')}
          warning
          onClick={handleClearChatHistory}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.etc.clearChatSnapshots')}
        desc={t('settings.etc.clearChatSnapshotsDesc')}
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
      >
        <ObsidianButton
          text={t('settings.etc.reset')}
          warning
          onClick={handleResetSettings}
        />
      </ObsidianSetting>
    </div>
  )
}
