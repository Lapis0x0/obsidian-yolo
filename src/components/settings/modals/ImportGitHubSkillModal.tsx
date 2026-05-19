import { App, Notice, normalizePath } from 'obsidian'
import { useCallback, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import { getYoloSkillsDir } from '../../../core/paths/yoloPaths'
import {
  fetchGitHubSkill,
  parseGitHubUrl,
} from '../../../core/skills/githubSkillImporter'
import { formatValidationErrors } from '../../../core/skills/importSkillValidationHelper'
import {
  type FileEntry,
  parseFrontmatter,
  validateDirectoryPackage,
  validateSingleFileSkill,
} from '../../../core/skills/skillValidation'
import { writeSkillPackages } from '../../../core/skills/skillWriter'
import YoloPlugin from '../../../main'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ReactModal } from '../../common/ReactModal'
import { ConfirmModal } from '../../modals/ConfirmModal'

type ImportGitHubSkillModalProps = {
  app: App
  plugin: YoloPlugin
  onImported?: () => void
}

export class ImportGitHubSkillModal extends ReactModal<ImportGitHubSkillModalProps> {
  constructor(app: App, plugin: YoloPlugin, onImported?: () => void) {
    super({
      app,
      Component: ImportGitHubSkillModalWrapper,
      props: { app, plugin, onImported },
      options: {
        title: plugin.t(
          'settings.agent.importGitHubSkill',
          'Import from GitHub',
        ),
      },
      plugin,
    })
  }
}

function ImportGitHubSkillModalWrapper({
  app,
  plugin,
  onImported,
  onClose,
}: ImportGitHubSkillModalProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <ImportGitHubSkillContent
        app={app}
        onImported={onImported}
        onClose={onClose}
      />
    </SettingsProvider>
  )
}

type SkillPackage = {
  sourceName: string
  targetName: string
  displayName: string
  description: string
  files: FileEntry[]
  isDirectory: boolean
}

function ImportGitHubSkillContent({
  app,
  onImported,
  onClose,
}: Omit<ImportGitHubSkillModalProps, 'plugin'> & { onClose: () => void }) {
  const { t } = useLanguage()
  const { settings } = useSettings()
  const skillsDir = getYoloSkillsDir(settings)

  const [url, setUrl] = useState('')
  const [isImporting, setIsImporting] = useState(false)

  const urlInfo = parseGitHubUrl(url)
  const canImport = urlInfo !== null && !isImporting

  const handleImport = useCallback(async () => {
    if (!urlInfo || isImporting) return

    setIsImporting(true)
    try {
      const result = await fetchGitHubSkill(url.trim())

      let validationErrors: Array<{ field: string; message: string }> = []

      if (result.isDirectory) {
        validationErrors = validateDirectoryPackage(
          result.targetName,
          result.files,
        )
      } else {
        validationErrors = validateSingleFileSkill(result.files[0].content)
      }

      if (validationErrors.length > 0) {
        new Notice(
          formatValidationErrors(
            validationErrors,
            result.sourceName,
            (key, fallback) => t(`settings.agent.${key}`, fallback),
          ),
        )
        return
      }

      const fm = parseFrontmatter(result.files[0].content)
      const displayName =
        (typeof fm?.name === 'string' && fm.name.trim()) || result.sourceName
      const description =
        (typeof fm?.description === 'string' && fm.description.trim()) || ''

      const pkg: SkillPackage = {
        ...result,
        displayName,
        description,
      }

      // Conflict detection
      const targetPath = normalizePath(`${skillsDir}/${pkg.targetName}`)
      if (app.vault.getAbstractFileByPath(targetPath)) {
        const modal = new ConfirmModal(app, {
          title: t(
            'settings.agent.importSkillConflictTitle',
            'Skill already exists',
          ),
          message: t(
            'settings.agent.importSkillConflictMessage',
            'A skill with the same name already exists. Do you want to overwrite it?',
          ).replace('{name}', pkg.targetName),
          ctaText: t(
            'settings.agent.importSkillConflictOverwrite',
            'Overwrite all',
          ),
          cancelText: t(
            'settings.agent.importSkillConflictSkip',
            'Skip conflicts',
          ),
          onConfirm: async () => {
            const { successCount } = await writeSkillPackages(app, skillsDir, [
              pkg,
            ])
            if (successCount > 0) {
              new Notice(
                t(
                  'settings.agent.importGitHubSkillSuccess',
                  'Successfully imported {count} skill(s)',
                ).replace('{count}', String(successCount)),
              )
              onImported?.()
              onClose()
            }
          },
        })
        modal.open()
        return
      }

      const { successCount, errors } = await writeSkillPackages(
        app,
        skillsDir,
        [pkg],
      )

      if (errors.length > 0) {
        new Notice(errors.join('\n\n'))
      }

      if (successCount > 0) {
        new Notice(
          t(
            'settings.agent.importGitHubSkillSuccess',
            'Successfully imported {count} skill(s)',
          ).replace('{count}', String(successCount)),
        )
        onImported?.()
        onClose()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('SKILL.md')) {
        new Notice(
          t(
            'settings.agent.importGitHubSkillNotSkillPackage',
            'This repository is not a valid skill package (SKILL.md not found at root)',
          ),
        )
      } else if (
        message.includes('fetch') ||
        message.includes('HTTP') ||
        message.includes('Network')
      ) {
        new Notice(
          t(
            'settings.agent.importGitHubSkillFetchError',
            'Failed to fetch: {error}',
          ).replace('{error}', message),
        )
      } else {
        new Notice(
          t(
            'settings.agent.importGitHubSkillNetworkError',
            'Network error. Please check the URL and your internet connection.',
          ),
        )
      }
    } finally {
      setIsImporting(false)
    }
  }, [url, urlInfo, isImporting, app, skillsDir, t, onImported, onClose])

  return (
    <div className="yolo-import-github-skill-modal">
      <div className="yolo-settings-desc yolo-settings-callout">
        {t(
          'settings.agent.importGitHubSkillDesc',
          'Paste a GitHub URL to import a skill. Supports single .md files or standard skill package repos.',
        )}
      </div>

      <div className="yolo-import-github-skill-input-row">
        <input
          type="text"
          className="yolo-import-github-skill-url-input"
          placeholder={t(
            'settings.agent.importGitHubSkillPlaceholder',
            'https://github.com/user/repo/...',
          )}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canImport) {
              void handleImport()
            }
          }}
          disabled={isImporting}
        />
        <ObsidianButton
          text={
            isImporting
              ? t('settings.agent.importGitHubSkillImporting', 'Importing...')
              : t('settings.agent.importSkillConfirm', 'Import')
          }
          cta
          disabled={!canImport}
          onClick={() => void handleImport()}
        />
      </div>
    </div>
  )
}
