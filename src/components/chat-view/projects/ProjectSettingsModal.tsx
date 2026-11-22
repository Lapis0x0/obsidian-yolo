import { ChevronDown, FileText } from 'lucide-react'
import { type App, Modal } from 'obsidian'
import { useMemo, useState } from 'react'
import { type Root, createRoot } from 'react-dom/client'
import { v4 as uuidv4 } from 'uuid'

import { AppProvider, useApp } from '../../../contexts/app-context'
import {
  LanguageProvider,
  useLanguage,
} from '../../../contexts/language-context'
import { PluginProvider } from '../../../contexts/plugin-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import type { CliRuntimeScope } from '../../../core/cli-runtime'
import { resolveProjectInstructionFilePaths } from '../../../core/project-instructions'
import type YoloPlugin from '../../../main'
import type { ChatProject } from '../../../types/project.types'
import { ObsidianIcon } from '../../common/ObsidianIcon'
import { ConfirmModal } from '../../modals/ConfirmModal'
import { AgentWorkspaceScopeEditor } from '../../settings/sections/AgentWorkspaceScopeEditor'
import { AgentPicker, useAgentDisplay } from '../agent-picker/AgentPicker'
import { parseAgentRef, serializeAgentRef } from '../agent-picker/agentRef'

import { PROJECT_COLORS, PROJECT_ICONS } from './projectAppearance'

type ProjectFormProps = {
  /** 编辑时传入；新建时不传 */
  project?: ChatProject
  cliRuntimeScope?: CliRuntimeScope
  onSaved: (project: ChatProject) => void
  onDelete?: (project: ChatProject) => void
  onClose: () => void
}

/** 工作区里实际存在的 AGENTS.md / CLAUDE.md：有才显示，YOLO 不替用户创建。 */
export function useExistingInstructionFiles(
  app: App,
  scope: ChatProject['workspaceScope'],
): string[] {
  return useMemo(
    () =>
      [...resolveProjectInstructionFilePaths(app, true, scope)].filter(
        (path) => app.vault.getFileByPath(path) !== null,
      ),
    [app, scope],
  )
}

function DefaultAgentField({
  value,
  cliRuntimeScope,
  onChange,
}: {
  value: string | undefined
  cliRuntimeScope?: CliRuntimeScope
  onChange: (value: string | undefined) => void
}) {
  const { t } = useLanguage()
  const ref = value ? parseAgentRef(value) : null
  const display = useAgentDisplay(
    ref ?? { kind: 'assistant', assistantId: '' },
    cliRuntimeScope,
  )
  return (
    <div className="yolo-project-form-agent">
      <AgentPicker
        current={ref ?? undefined}
        onPick={(picked) => onChange(serializeAgentRef(picked))}
        cliRuntimeScope={cliRuntimeScope}
        triggerClassName="yolo-assistant-selector-button yolo-project-form-agent-trigger"
        triggerContent={
          <>
            {ref ? (
              <div className="yolo-assistant-selector-current-icon">
                {display.icon}
              </div>
            ) : null}
            <div className="yolo-assistant-selector-current">
              {ref
                ? display.name
                : t('chat.projects.followCurrentAgent', 'Current agent')}
            </div>
            <div className="yolo-assistant-selector-icon">
              <ChevronDown size={10} />
            </div>
          </>
        }
      />
      {ref ? (
        <button
          type="button"
          className="yolo-project-form-link"
          onClick={() => onChange(undefined)}
        >
          {t('chat.projects.clearDefaultAgent', 'Use the current agent')}
        </button>
      ) : null}
    </div>
  )
}

function ProjectForm({
  project,
  cliRuntimeScope,
  onSaved,
  onDelete,
  onClose,
}: ProjectFormProps) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const app = useApp()
  const [name, setName] = useState(project?.name ?? '')
  const [icon, setIcon] = useState(project?.icon ?? PROJECT_ICONS[0])
  const [color, setColor] = useState(project?.color ?? PROJECT_COLORS[0])
  const [workspaceScope, setWorkspaceScope] = useState<
    ChatProject['workspaceScope']
  >(project?.workspaceScope ?? { enabled: true, include: [], exclude: [] })
  const [defaultAgent, setDefaultAgent] = useState(project?.defaultAgent)
  const instructionFiles = useExistingInstructionFiles(app, workspaceScope)
  const trimmedName = name.trim()

  const save = () => {
    if (!trimmedName) return
    const now = Date.now()
    const next: ChatProject = {
      id: project?.id ?? uuidv4(),
      name: trimmedName,
      icon,
      color,
      workspaceScope,
      defaultAgent,
      createdAt: project?.createdAt ?? now,
      updatedAt: now,
    }
    const projects = settings.projects ?? []
    void setSettings({
      ...settings,
      projects: project
        ? projects.map((item) => (item.id === project.id ? next : item))
        : [...projects, next],
    })
      .then(() => {
        onSaved(next)
        onClose()
      })
      .catch((error: unknown) => {
        console.error('Failed to save project', error)
      })
  }

  return (
    <div className="yolo-project-form">
      <label className="yolo-project-form-field">
        <span className="yolo-project-form-label">
          {t('chat.projects.name', 'Name')}
        </span>
        <input
          type="text"
          value={name}
          autoFocus
          placeholder={t('chat.projects.namePlaceholder', 'e.g. Thesis')}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save()
          }}
        />
      </label>

      <div className="yolo-project-form-field">
        <span className="yolo-project-form-label">
          {t('chat.projects.appearance', 'Icon')}
        </span>
        <div className="yolo-project-form-swatches">
          {PROJECT_ICONS.map((item) => (
            <button
              key={item}
              type="button"
              className={`yolo-project-icon-option${item === icon ? ' is-selected' : ''}`}
              style={{ '--yolo-project-color': color } as React.CSSProperties}
              aria-pressed={item === icon}
              aria-label={item}
              onClick={() => setIcon(item)}
            >
              <ObsidianIcon name={item} />
            </button>
          ))}
        </div>
        <div className="yolo-project-form-swatches">
          {PROJECT_COLORS.map((item) => (
            <button
              key={item}
              type="button"
              className={`yolo-project-color-option${item === color ? ' is-selected' : ''}`}
              style={{ '--yolo-project-color': item } as React.CSSProperties}
              aria-pressed={item === color}
              aria-label={item}
              onClick={() => setColor(item)}
            />
          ))}
        </div>
      </div>

      <div className="yolo-project-form-field">
        <span className="yolo-project-form-label">
          {t('chat.projects.workspace', 'Workspace')}
        </span>
        <span className="yolo-project-form-hint">
          {t(
            'chat.projects.workspaceHint',
            "Replaces the agent's own workspace for every conversation in this project. CLI agents use their own tools and are not restricted.",
          )}
        </span>
        <AgentWorkspaceScopeEditor
          app={app}
          vault={app.vault}
          value={workspaceScope}
          onChange={setWorkspaceScope}
        />
      </div>

      <div className="yolo-project-form-field">
        <span className="yolo-project-form-label">
          {t('chat.projects.defaultAgent', 'Default agent')}
        </span>
        <DefaultAgentField
          value={defaultAgent}
          cliRuntimeScope={cliRuntimeScope}
          onChange={setDefaultAgent}
        />
      </div>

      {instructionFiles.length > 0 ? (
        <div className="yolo-project-form-field">
          <span className="yolo-project-form-label">
            {t('chat.projects.instructions', 'Project instructions')}
          </span>
          <span className="yolo-project-form-hint">
            {t(
              'chat.projects.instructionsHint',
              'Every conversation in this project reads these files — the same AGENTS.md that Claude Code and Codex read.',
            )}
          </span>
          {instructionFiles.map((path) => (
            <button
              key={path}
              type="button"
              className="yolo-project-form-file"
              onClick={() => {
                void app.workspace.openLinkText(path, '', 'tab')
                onClose()
              }}
            >
              <FileText size={14} />
              <span>{path}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="yolo-project-form-actions">
        {project && onDelete ? (
          <button
            type="button"
            className="mod-warning"
            onClick={() => {
              new ConfirmModal(app, {
                title: t('chat.projects.deleteTitle', 'Delete project'),
                message: t(
                  'chat.projects.deleteMessage',
                  'Its conversations are kept and move back to Recent.',
                ),
                ctaText: t('common.delete', 'Delete'),
                onConfirm: () => {
                  onDelete(project)
                  onClose()
                },
              }).open()
            }}
          >
            {t('common.delete', 'Delete')}
          </button>
        ) : null}
        <div className="yolo-project-form-actions-spacer" />
        <button type="button" onClick={onClose}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button
          type="button"
          className="mod-cta"
          disabled={!trimmedName}
          onClick={save}
        >
          {project
            ? t('common.save', 'Save')
            : t('chat.projects.create', 'Create project')}
        </button>
      </div>
    </div>
  )
}

/**
 * 新建 / 编辑项目的弹窗。挂自己的 React 根并补齐 settings / app 上下文：
 * 默认 Agent 字段用的是和头部同一个 AgentPicker。
 */
export class ProjectSettingsModal extends Modal {
  private root: Root | null = null

  constructor(
    app: App,
    private plugin: YoloPlugin,
    private options: Omit<ProjectFormProps, 'onClose'>,
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText(
      this.options.project
        ? this.plugin.t('chat.projects.editTitle', 'Project settings')
        : this.plugin.t('chat.projects.newTitle', 'New project'),
    )
    this.modalEl.addClass('yolo-project-modal')
    this.root = createRoot(this.contentEl)
    this.root.render(
      <PluginProvider plugin={this.plugin}>
        <LanguageProvider>
          <AppProvider app={this.app}>
            <SettingsProvider
              settings={this.plugin.settings}
              setSettings={(next) => this.plugin.setSettings(next)}
              addSettingsChangeListener={(listener) =>
                this.plugin.addSettingsChangeListener(listener)
              }
            >
              <ProjectForm {...this.options} onClose={() => this.close()} />
            </SettingsProvider>
          </AppProvider>
        </LanguageProvider>
      </PluginProvider>,
    )
  }

  onClose(): void {
    this.root?.unmount()
    this.root = null
    this.contentEl.empty()
  }
}
