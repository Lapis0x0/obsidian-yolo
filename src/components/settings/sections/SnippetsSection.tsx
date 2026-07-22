import { App, Notice, TFile } from 'obsidian'
import { useCallback, useMemo } from 'react'

import { AppProvider } from '../../../contexts/app-context'
import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import { getYoloSnippetsPath } from '../../../core/paths/yoloPaths'
import { openSnippetsFileInVault } from '../../../core/snippets/snippetsFile'
import { useSnippetEntries } from '../../chat-view/hooks/useSnippetEntries'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { SnippetsManagerModal } from '../modals/SnippetsManagerModal'

type SnippetsSectionProps = {
  app: App
}

export function SnippetsSection({ app }: SnippetsSectionProps) {
  return (
    <AppProvider app={app}>
      <SnippetsSectionInner app={app} />
    </AppProvider>
  )
}

function SnippetsSectionInner({ app }: SnippetsSectionProps) {
  const { t } = useLanguage()
  const { settings } = useSettings()
  const plugin = usePlugin()
  const entries = useSnippetEntries()

  const snippetsPath = getYoloSnippetsPath(settings)
  // useSnippetEntries re-fetches on vault create/modify/delete/rename of
  // snippets.md, so depending on `entries` is enough to keep this in sync.
  const fileExists = useMemo(() => {
    void entries
    return app.vault.getAbstractFileByPath(snippetsPath) instanceof TFile
  }, [app, snippetsPath, entries])

  const cardDesc = fileExists
    ? t('settings.editor.snippets.cardDescCount', '{count} snippets').replace(
        '{count}',
        String(entries.length),
      )
    : t('settings.editor.snippets.cardDescMissing', 'No snippets.md file yet')

  const handleManage = () => {
    new SnippetsManagerModal(app, plugin).open()
  }

  // Cold-start onboarding: when snippets.md doesn't exist yet, skip the modal
  // and one-click create the file from the template. Once the file exists we
  // always go through the modal (even with 0 parseable entries) so we never
  // risk overwriting user content.
  const handleInit = useCallback(() => {
    void (async () => {
      try {
        await openSnippetsFileInVault(app, settings)
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
  }, [app, settings, t])

  return (
    <div className="yolo-settings-section">
      <section className="yolo-settings-block">
        <div className="yolo-settings-block-head">
          <div className="yolo-settings-block-head-title-row">
            <div className="yolo-settings-sub-header yolo-settings-block-title">
              {t('settings.editor.snippets.sectionTitle', 'Snippets')}
            </div>
            <div className="yolo-settings-desc yolo-settings-block-desc">
              {t(
                'settings.editor.snippets.sectionDesc',
                'Type / in the chat input and pick a snippet to insert a preset prompt. Snippets live in {{path}}.',
              ).replace('{{path}}', snippetsPath)}
            </div>
          </div>
        </div>

        <div className="yolo-settings-block-content">
          <ObsidianSetting
            name={t('settings.editor.snippets.cardName', 'Snippet library')}
            desc={cardDesc}
            className="yolo-settings-card"
          >
            {fileExists ? (
              <ObsidianButton
                text={t(
                  'settings.editor.snippets.manageBtn',
                  'Manage snippets',
                )}
                onClick={handleManage}
              />
            ) : (
              <ObsidianButton
                text={t(
                  'settings.editor.snippets.initBtn',
                  'Initialize snippets',
                )}
                onClick={handleInit}
              />
            )}
          </ObsidianSetting>
        </div>
      </section>
    </div>
  )
}
