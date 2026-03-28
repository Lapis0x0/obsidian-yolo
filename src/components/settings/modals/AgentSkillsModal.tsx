import { App, Notice } from 'obsidian'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import {
  getYoloSkillsDir,
  getYoloSkillsIndexPath,
} from '../../../core/paths/yoloPaths'
import { listLiteSkillEntries } from '../../../core/skills/liteSkills'
import { YOLO_SKILLS_INDEX_TEMPLATE } from '../../../core/skills/templates'
import SmartComposerPlugin from '../../../main'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'

type AgentSkillsModalProps = {
  app: App
  plugin: SmartComposerPlugin
}

export class AgentSkillsModal extends ReactModal<AgentSkillsModalProps> {
  constructor(app: App, plugin: SmartComposerPlugin) {
    super({
      app,
      Component: AgentSkillsModalWrapper,
      props: { app, plugin },
      options: {
        title: plugin.t('settings.agent.manageSkills', 'Manage skills'),
      },
      plugin,
    })
    this.modalEl.classList.add('smtcmp-modal--wide')
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
  plugin: SmartComposerPlugin
}) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const [refreshTick, setRefreshTick] = useState(0)
  const skillsDir = getYoloSkillsDir(settings)

  const disabledSkillIds = settings.skills?.disabledSkillIds ?? []
  const disabledSkillIdSet = useMemo(
    () => new Set(disabledSkillIds),
    [disabledSkillIds],
  )

  const skills = useMemo(() => {
    void refreshTick
    return listLiteSkillEntries(app, { settings })
  }, [app, refreshTick, settings])

  const handleToggleSkill = (skillId: string, enabled: boolean) => {
    const current = new Set(settings.skills?.disabledSkillIds ?? [])
    if (enabled) {
      current.delete(skillId)
    } else {
      current.add(skillId)
    }

    void setSettings({
      ...settings,
      skills: {
        ...(settings.skills ?? { disabledSkillIds: [] }),
        disabledSkillIds: [...current],
      },
    })
  }

  const handleInitializeSkillsSystem = async () => {
    const indexPath = getYoloSkillsIndexPath(settings)

    try {
      const maybeFolder = app.vault.getAbstractFileByPath(skillsDir)
      if (!maybeFolder) {
        await app.vault.createFolder(skillsDir)
      }

      if (!app.vault.getAbstractFileByPath(indexPath)) {
        await app.vault.create(
          indexPath,
          YOLO_SKILLS_INDEX_TEMPLATE.split('YOLO/skills').join(skillsDir),
        )
      }

      setRefreshTick((value) => value + 1)
      new Notice(
        t(
          'settings.agent.skillsTemplateCreated',
          'Skills system initialized in {path}.',
        ).replace('{path}', skillsDir),
      )
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create skill files.'
      new Notice(message)
    }
  }

  return (
    <div className="smtcmp-settings-section">
      <div className="smtcmp-settings-desc smtcmp-settings-callout">
        {t(
          'settings.agent.skillsGlobalDesc',
          'Skills are discovered from built-in skills and {path}/**/*.md (excluding Skills.md where applicable). Disable a skill here to block it for all agents.',
        ).replace('{path}', skillsDir)}
      </div>

      <div className="smtcmp-agent-skills-toolbar">
        <div className="smtcmp-settings-desc">
          {t(
            'settings.agent.skillsSourcePath',
            'Source: built-in skills + {path}/*.md + {path}/**/SKILL.md',
          )
            .split('{path}')
            .join(skillsDir)}
        </div>
        <div className="smtcmp-agent-skills-toolbar-actions">
          <ObsidianButton
            text={t(
              'settings.agent.createSkillTemplates',
              'Initialize Skills system',
            )}
            onClick={() => void handleInitializeSkillsSystem()}
          />
          <ObsidianButton
            text={t('settings.agent.refreshSkills', 'Refresh')}
            onClick={() => setRefreshTick((value) => value + 1)}
          />
        </div>
      </div>

      <div className="smtcmp-agent-tools-panel smtcmp-agent-skills-modal-panel">
        <div className="smtcmp-agent-tools-panel-head">
          <div className="smtcmp-agent-tools-panel-title">
            {t('settings.agent.skills', 'Skills')}
          </div>
          <div className="smtcmp-agent-tools-panel-count">
            {t(
              'settings.agent.skillsCountWithEnabled',
              '{count} skills (enabled {enabled})',
            )
              .replace('{count}', String(skills.length))
              .replace(
                '{enabled}',
                String(
                  skills.filter((skill) => !disabledSkillIdSet.has(skill.id))
                    .length,
                ),
              )}
          </div>
        </div>

        {skills.length > 0 ? (
          <div className="smtcmp-agent-tool-list">
            {skills.map((skill) => {
              const enabled = !disabledSkillIdSet.has(skill.id)
              return (
                <div key={skill.id} className="smtcmp-agent-tool-row">
                  <div className="smtcmp-agent-tool-main">
                    <div className="smtcmp-agent-tool-name">{skill.name}</div>
                    <div className="smtcmp-agent-tool-source smtcmp-agent-tool-source--preview">
                      {skill.description}
                    </div>
                    <div className="smtcmp-agent-skill-meta">
                      <span className="smtcmp-agent-chip">id: {skill.id}</span>
                      <span className="smtcmp-agent-chip">{skill.path}</span>
                    </div>
                  </div>
                  <div className="smtcmp-agent-tool-toggle">
                    <ObsidianToggle
                      value={enabled}
                      onChange={(value) => handleToggleSkill(skill.id, value)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="smtcmp-agent-tools-empty">
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
