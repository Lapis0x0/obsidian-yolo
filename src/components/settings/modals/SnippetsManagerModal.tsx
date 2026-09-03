import { App, Notice, TFile } from 'obsidian'
import { useCallback, useMemo } from 'react'

import { AppProvider } from '../../../contexts/app-context'
import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import { getYoloSnippetsPath } from '../../../core/paths/yoloPaths'
import { openSnippetsFileInVault } from '../../../core/snippets/snippetsFile'
import { removeSnippetBlock } from '../../../core/snippets/snippetsManager'
import type YoloPlugin from '../../../main'
import { useSnippetEntries } from '../../chat-view/hooks/useSnippetEntries'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ReactModal } from '../../common/ReactModal'
import { ConfirmModal } from '../../modals/ConfirmModal'

type SnippetsManagerModalProps = {
  app: App
  plugin: YoloPlugin
}

export class SnippetsManagerModal extends ReactModal<SnippetsManagerModalProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app,
      Component: SnippetsManagerModalWrapper,
      props: { app, plugin },
      options: {
        title: plugin.t('settings.editor.snippets.modalTitle', '管理快捷指令'),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

function SnippetsManagerModalWrapper({
  app,
  plugin,
  onClose,
}: SnippetsManagerModalProps & { onClose: () => void }) {
  return (
    <AppProvider app={app}>
      <SettingsProvider
        settings={plugin.settings}
        setSettings={(newSettings) => plugin.setSettings(newSettings)}
        addSettingsChangeListener={(listener) =>
          plugin.addSettingsChangeListener(listener)
        }
      >
        <SnippetsManagerModalContent app={app} onClose={onClose} />
      </SettingsProvider>
    </AppProvider>
  )
}

function SnippetsManagerModalContent({
  app,
  onClose,
}: {
  app: App
  onClose: () => void
}) {
  const { t } = useLanguage()
  const { settings } = useSettings()
  const entries = useSnippetEntries()
  const snippetsPath = getYoloSnippetsPath(settings)

  const fileExists = useMemo(() => {
    return app.vault.getAbstractFileByPath(snippetsPath) instanceof TFile
  }, [app, snippetsPath, entries])

  const handleOpenOrCreate = useCallback(() => {
    void (async () => {
      try {
        await openSnippetsFileInVault(app, settings)
        onClose()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        new Notice(
          t(
            'settings.editor.snippets.openError',
            'Failed to open snippets.md: {error}',
          ).replace('{error}', message),
        )
      }
    })()
  }, [app, settings, onClose, t])

  const handleJump = useCallback(
    (trigger: string) => {
      void (async () => {
        try {
          await openSnippetsFileInVault(app, settings, { heading: trigger })
          onClose()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          new Notice(
            t(
              'settings.editor.snippets.openError',
              'Failed to open snippets.md: {error}',
            ).replace('{error}', message),
          )
        }
      })()
    },
    [app, settings, onClose, t],
  )

  const handleDelete = useCallback(
    (trigger: string) => {
      const message = t(
        'settings.editor.snippets.deleteMessage',
        'Are you sure you want to delete snippet "{trigger}"? This cannot be undone.',
      ).replace('{trigger}', trigger)
      const modal = new ConfirmModal(app, {
        title: t('settings.editor.snippets.deleteTitle', 'Delete snippet'),
        message,
        ctaText: t('settings.editor.snippets.deleteConfirm', 'Delete'),
        onConfirm: () => {
          void (async () => {
            try {
              const file = app.vault.getAbstractFileByPath(snippetsPath)
              if (!(file instanceof TFile)) {
                throw new Error(`snippets.md not found at ${snippetsPath}`)
              }
              // Use vault.read (not cachedRead) so back-to-back deletes always
              // see the latest on-disk content, even if the vault cache lags.
              const content = await app.vault.read(file)
              const next = removeSnippetBlock(content, trigger)
              if (next === content) return
              await app.vault.modify(file, next)
              new Notice(
                t(
                  'settings.editor.snippets.deleteSuccess',
                  'Deleted snippet "{trigger}"',
                ).replace('{trigger}', trigger),
              )
            } catch (error) {
              const errMessage =
                error instanceof Error ? error.message : String(error)
              new Notice(
                t(
                  'settings.editor.snippets.deleteError',
                  'Delete failed: {error}',
                ).replace('{error}', errMessage),
              )
            }
          })()
        },
      })
      modal.open()
    },
    [app, snippetsPath, t],
  )

  return (
    <div className="yolo-settings-section">
      <div className="yolo-settings-desc yolo-settings-callout">
        {t(
          'settings.editor.snippets.modalCallout',
          'Snippets live in YOLO/snippets.md. Trigger the chat input with / and pick one to insert its body.',
        )}
      </div>

      <div className="yolo-agent-skills-toolbar">
        <div className="yolo-agent-skills-toolbar-actions">
          <ObsidianButton
            text={
              fileExists
                ? t('settings.editor.snippets.openFileBtn', 'Open snippets.md')
                : t(
                    'settings.editor.snippets.createFileBtn',
                    'Create snippets.md',
                  )
            }
            onClick={handleOpenOrCreate}
          />
        </div>
      </div>

      <div className="yolo-agent-tools-panel yolo-agent-skills-modal-panel">
        <div className="yolo-agent-tools-panel-head">
          <div className="yolo-agent-tools-panel-title">
            {t('settings.editor.snippets.sectionTitle', 'Snippets')}
          </div>
          <div className="yolo-agent-tools-panel-count">
            {t(
              'settings.editor.snippets.cardDescCount',
              '{count} snippets',
            ).replace('{count}', String(entries.length))}
          </div>
        </div>

        {entries.length > 0 ? (
          <div className="yolo-agent-tool-list">
            {entries.map((entry) => {
              const previewSource = entry.content.split(/\r?\n/)[0] ?? ''
              const preview =
                previewSource.length > 60
                  ? `${previewSource.slice(0, 60)}…`
                  : previewSource
              return (
                <div key={entry.id} className="yolo-agent-tool-row">
                  <div className="yolo-agent-tool-main">
                    <div className="yolo-agent-tool-name">{entry.trigger}</div>
                    {entry.description && (
                      <div className="yolo-agent-tool-source">
                        {entry.description}
                      </div>
                    )}
                    <div className="yolo-agent-tool-source yolo-agent-tool-source--preview">
                      {preview}
                    </div>
                  </div>
                  <div className="yolo-agent-skills-toolbar-actions">
                    <ObsidianButton
                      text={t('settings.editor.snippets.jumpBtn', 'Edit')}
                      onClick={() => handleJump(entry.trigger)}
                    />
                    <ObsidianButton
                      text={t('settings.editor.snippets.deleteBtn', 'Delete')}
                      warning
                      onClick={() => handleDelete(entry.trigger)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="yolo-agent-tools-empty">
            {t('settings.editor.snippets.empty', 'No snippets yet')}
          </div>
        )}
      </div>
    </div>
  )
}
