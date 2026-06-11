import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian'
import { useCallback, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import { getYoloSkillsDir } from '../../../core/paths/yoloPaths'
import { humanizeSkillName } from '../../../core/skills/liteSkills'
import { useLiteSkillEntries } from '../../../hooks/useLiteSkillEntries'
import YoloPlugin from '../../../main'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'
import { ConfirmModal } from '../../modals/ConfirmModal'

import { ImportSkillModal } from './ImportSkillModal'

type AgentSkillsModalProps = {
  app: App
  plugin: YoloPlugin
}

export class AgentSkillsModal extends ReactModal<AgentSkillsModalProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app,
      Component: AgentSkillsModalWrapper,
      props: { app, plugin },
      options: {
        title: plugin.t('settings.agent.manageSkills', 'Manage skills'),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

function AgentSkillsModalWrapper({
  app,
  plugin,
  onClose: _onClose,
}: AgentSkillsModalProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <AgentSkillsModalContent app={app} plugin={plugin} />
    </SettingsProvider>
  )
}

function AgentSkillsModalContent({
  app,
  plugin: _plugin,
}: {
  app: App
  plugin: YoloPlugin
}) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const [refreshTick, setRefreshTick] = useState(0)
  const [isSelectMode, setIsSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const skillsDir = getYoloSkillsDir(settings)

  const disabledSkillNames = settings.skills?.disabledSkillIds ?? []
  const disabledSkillNameSet = useMemo(
    () => new Set(disabledSkillNames),
    [disabledSkillNames],
  )

  const skills = useLiteSkillEntries(app, { settings, refreshTick })

  const deletableSkills = useMemo(
    () => skills.filter((s) => !s.path.startsWith('builtin://')),
    [skills],
  )

  const handleToggleSkill = (skillName: string, enabled: boolean) => {
    const current = new Set(settings.skills?.disabledSkillIds ?? [])
    if (enabled) {
      current.delete(skillName)
    } else {
      current.add(skillName)
    }

    void setSettings({
      ...settings,
      skills: {
        ...(settings.skills ?? { disabledSkillIds: [] }),
        disabledSkillIds: [...current],
      },
    })
  }

  const handleOpenImportModal = () => {
    const modal = new ImportSkillModal(app, _plugin, () => {
      // 延迟刷新，等待 vault 文件索引更新
      setTimeout(() => {
        setRefreshTick((value) => value + 1)
      }, 300)
    })
    modal.open()
  }

  // 选择模式
  const handleEnterSelectMode = () => {
    setIsSelectMode(true)
    setSelectedIds(new Set())
  }

  const handleExitSelectMode = () => {
    setIsSelectMode(false)
    setSelectedIds(new Set())
  }

  const handleToggleSelect = useCallback((skillName: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(skillName)) {
        next.delete(skillName)
      } else {
        next.add(skillName)
      }
      return next
    })
  }, [])

  const handleSelectAll = useCallback(() => {
    setSelectedIds(new Set(deletableSkills.map((s) => s.name)))
  }, [deletableSkills])

  const deleteSkillPath = async (path: string) => {
    const normalizedPath = normalizePath(path)
    const file = app.vault.getAbstractFileByPath(normalizedPath)
    if (file) {
      if (file instanceof TFile) {
        const parent = file.parent
        if (
          parent &&
          parent.path !== skillsDir &&
          parent instanceof TFolder &&
          file.name === 'SKILL.md'
        ) {
          await app.fileManager.trashFile(parent)
        } else {
          await app.fileManager.trashFile(file)
        }
      } else if (file instanceof TFolder) {
        await app.fileManager.trashFile(file)
      }
      return
    }

    if (!(await app.vault.adapter.exists(normalizedPath))) {
      throw new Error('Skill file not found')
    }

    if (normalizedPath.endsWith('/SKILL.md')) {
      const parentPath = normalizedPath.slice(
        0,
        normalizedPath.lastIndexOf('/'),
      )
      await app.vault.adapter.rmdir(parentPath, true)
      return
    }

    await app.vault.adapter.remove(normalizedPath)
  }

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return

    const selectedSkills = skills.filter((s) => selectedIds.has(s.name))
    const names = selectedSkills.map((s) => s.name)

    const modal = new ConfirmModal(app, {
      title: t('settings.agent.deleteSkillTitle', 'Delete skill'),
      message: t(
        'settings.agent.deleteSkillBatchMessage',
        'Are you sure you want to delete {count} skill(s)? This cannot be undone.',
      ).replace('{count}', String(names.length)),
      ctaText: t('settings.agent.deleteSkillConfirm', 'Delete'),
      onConfirm: async () => {
        let successCount = 0
        for (const skill of selectedSkills) {
          try {
            await deleteSkillPath(skill.path)
            successCount++
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error'
            new Notice(
              t(
                'settings.agent.deleteSkillError',
                'Failed to delete "{name}": {error}',
              )
                .replace('{name}', skill.name)
                .replace('{error}', message),
            )
          }
        }

        if (successCount > 0) {
          new Notice(
            t(
              'settings.agent.deleteSkillBatchSuccess',
              'Deleted {count} skill(s).',
            ).replace('{count}', String(successCount)),
          )
        }

        setIsSelectMode(false)
        setSelectedIds(new Set())
        setRefreshTick((value) => value + 1)
      },
    })
    modal.open()
  }

  return (
    <div className="yolo-settings-section">
      <div className="yolo-settings-desc yolo-settings-callout">
        {t(
          'settings.agent.skillsGlobalDesc',
          'Skills are discovered from built-in skills and {path}/**/*.md (excluding Skills.md where applicable). Disable a skill here to block it for all agents.',
        ).replace('{path}', skillsDir)}
      </div>

      <div className="yolo-agent-skills-toolbar">
        <div className="yolo-agent-skills-toolbar-actions">
          {isSelectMode ? (
            <div
              key="select-mode"
              className="yolo-agent-skills-toolbar-actions"
            >
              <ObsidianButton
                text={t('settings.agent.deleteSkillSelectAll', 'Select all')}
                onClick={handleSelectAll}
              />
              <ObsidianButton
                text={`${t('settings.agent.deleteSkillBatchBtn', 'Delete')} (${selectedIds.size})`}
                warning
                disabled={selectedIds.size === 0}
                onClick={handleDeleteSelected}
              />
              <ObsidianButton
                text={t('settings.agent.deleteSkillCancel', 'Cancel')}
                onClick={handleExitSelectMode}
              />
            </div>
          ) : (
            <div
              key="normal-mode"
              className="yolo-agent-skills-toolbar-actions"
            >
              <ObsidianButton
                text={t('settings.agent.importSkill', 'Import Skill')}
                onClick={handleOpenImportModal}
              />
              {deletableSkills.length > 0 && (
                <ObsidianButton
                  text={t('settings.agent.selectSkills', 'Select')}
                  onClick={handleEnterSelectMode}
                />
              )}
              <ObsidianButton
                text={t('settings.agent.refreshSkills', 'Refresh')}
                onClick={() => setRefreshTick((value) => value + 1)}
              />
            </div>
          )}
        </div>
      </div>

      <div className="yolo-agent-tools-panel yolo-agent-skills-modal-panel">
        <div className="yolo-agent-tools-panel-head">
          <div className="yolo-agent-tools-panel-title">
            {t('settings.agent.skills', 'Skills')}
          </div>
          <div className="yolo-agent-tools-panel-count">
            {t(
              'settings.agent.skillsCountWithEnabled',
              '{count} skills (enabled {enabled})',
            )
              .replace('{count}', String(skills.length))
              .replace(
                '{enabled}',
                String(
                  skills.filter(
                    (skill) => !disabledSkillNameSet.has(skill.name),
                  ).length,
                ),
              )}
          </div>
        </div>

        {skills.length > 0 ? (
          <div className="yolo-agent-tool-list">
            {skills
              .filter((skill) =>
                isSelectMode ? !skill.path.startsWith('builtin://') : true,
              )
              .map((skill) => {
                const enabled = !disabledSkillNameSet.has(skill.name)
                const isSelected = selectedIds.has(skill.name)

                return (
                  <div
                    key={skill.name}
                    className={`yolo-agent-tool-row ${isSelectMode && isSelected ? 'is-selected' : ''}`}
                  >
                    {isSelectMode && (
                      <input
                        type="checkbox"
                        className="yolo-agent-skill-checkbox"
                        checked={isSelected}
                        onChange={() => handleToggleSelect(skill.name)}
                      />
                    )}
                    <div className="yolo-agent-tool-main">
                      <div className="yolo-agent-tool-name">
                        {humanizeSkillName(skill.name)}
                      </div>
                      <div className="yolo-agent-tool-source yolo-agent-tool-source--preview">
                        {skill.description}
                      </div>
                      <div className="yolo-agent-skill-meta">
                        <span className="yolo-agent-chip">
                          name: {skill.name}
                        </span>
                        <span className="yolo-agent-chip">{skill.path}</span>
                      </div>
                    </div>
                    {!isSelectMode && (
                      <div className="yolo-agent-tool-toggle">
                        <ObsidianToggle
                          value={enabled}
                          onChange={(value) =>
                            handleToggleSkill(skill.name, value)
                          }
                        />
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        ) : (
          <div className="yolo-agent-tools-empty">
            {t(
              'settings.agent.skillsEmptyHint',
              'No skills found. Create skill markdown files under {path}.',
            ).replace('{path}', skillsDir)}
          </div>
        )}
      </div>
    </div>
  )
}
