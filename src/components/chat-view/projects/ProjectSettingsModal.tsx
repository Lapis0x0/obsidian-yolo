import { Ban, Bot, ChevronDown, FileText, Folder, Globe } from 'lucide-react'
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
import { ScopeEditorModal } from '../../settings/scope/ScopeEditorModal'
import {
  estimateFiles,
  rulesFromWorkspaceScope,
  workspaceScopeFromRules,
} from '../../settings/scope/scopeRules'
import { collectScopeCandidateFiles } from '../../settings/scope/scopeVault'
import { AgentPicker, useAgentDisplay } from '../agent-picker/AgentPicker'
import { parseAgentRef, serializeAgentRef } from '../agent-picker/agentRef'

import {
  PROJECT_COLORS,
  PROJECT_COLOR_IDS,
  PROJECT_ICONS,
  getProjectColorId,
  projectColorStyle,
} from './projectAppearance'

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

/**
 * 工作区卡片：列出包含 / 排除的路径和可访问文件数，「编辑范围」打开与 Agent
 * 设置同一个范围编辑器。项目的工作区总是生效，没有开关。
 */
function WorkspaceCard({
  value,
  color,
  onChange,
}: {
  value: ChatProject['workspaceScope']
  color: string
  onChange: (value: ChatProject['workspaceScope']) => void
}) {
  const { t } = useLanguage()
  const app = useApp()
  const rules = useMemo(() => rulesFromWorkspaceScope(value), [value])
  const candidateFiles = useMemo(
    () => collectScopeCandidateFiles(app.vault),
    [app.vault],
  )
  const estimate = useMemo(
    () => estimateFiles(candidateFiles, rules),
    [candidateFiles, rules],
  )
  const openEditor = () => {
    new ScopeEditorModal(app, app.vault, {
      rules,
      defaultRules: [],
      allowFiles: true,
      variant: 'agent',
      candidateFiles,
      onSave: (nextRules) =>
        onChange({
          enabled: true,
          ...workspaceScopeFromRules(nextRules),
        }),
    }).open()
  }

  return (
    <div className="yolo-project-card">
      {value.include.length === 0 ? (
        <div className="yolo-project-card-row">
          <Globe size={15} className="yolo-project-card-row-icon" />
          <span className="yolo-project-card-row-main">
            {t('chat.projects.wholeVault', 'Whole vault')}
          </span>
        </div>
      ) : null}
      {value.include.map((path) => (
        <div key={`include:${path}`} className="yolo-project-card-row">
          <Folder
            size={15}
            className="yolo-project-card-row-icon"
            style={{ color }}
          />
          <span className="yolo-project-card-row-main">{path}</span>
        </div>
      ))}
      {value.exclude.map((path) => (
        <div key={`exclude:${path}`} className="yolo-project-card-row">
          <Ban size={15} className="yolo-project-card-row-icon" />
          <span className="yolo-project-card-row-main">{path}</span>
          <span className="yolo-project-card-row-meta">
            {t('chat.projects.excluded', 'Excluded')}
          </span>
        </div>
      ))}
      <div className="yolo-project-card-footer">
        <span>
          {t(
            'chat.projects.accessibleFiles',
            '{matched} / {total} files accessible',
          )
            .replace('{matched}', estimate.matched.toLocaleString())
            .replace('{total}', estimate.total.toLocaleString())}
        </span>
        <button
          type="button"
          className="yolo-project-card-button"
          onClick={openEditor}
        >
          {t('settings.scope.editRange', 'Edit range')}
        </button>
      </div>
    </div>
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
    <AgentPicker
      current={ref ?? undefined}
      onPick={(picked) => onChange(serializeAgentRef(picked))}
      cliRuntimeScope={cliRuntimeScope}
      triggerClassName="yolo-project-agent-trigger"
      triggerContent={
        <>
          <span
            className={`yolo-project-agent-avatar${
              ref ? ` is-${ref.kind === 'assistant' ? 'yolo' : 'cli'}` : ''
            }`}
          >
            {ref ? display.icon : <Bot size={14} />}
          </span>
          <span className="yolo-project-agent-name">
            {ref
              ? display.name
              : t('chat.projects.followCurrentAgent', 'Current agent')}
          </span>
          <span className="yolo-project-agent-source">
            {ref
              ? ref.kind === 'assistant'
                ? 'YOLO'
                : 'CLI'
              : t('chat.projects.noDefaultAgent', 'Not set')}
          </span>
          <ChevronDown size={13} className="yolo-project-agent-chevron" />
        </>
      }
    />
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
  const [color, setColor] = useState(getProjectColorId(project?.color))
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
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
    <div className="yolo-project-form" style={projectColorStyle(color)}>
      <div className="yolo-project-form-identity">
        <div className="yolo-project-form-name-row">
          <button
            type="button"
            className="yolo-project-form-icon"
            aria-label={t('chat.projects.chooseIcon', 'Choose icon')}
            aria-expanded={iconPickerOpen}
            onClick={() => setIconPickerOpen((open) => !open)}
          >
            <ObsidianIcon name={icon} />
          </button>
          <input
            type="text"
            className="yolo-project-form-name"
            value={name}
            autoFocus
            aria-label={t('chat.projects.name', 'Name')}
            placeholder={t('chat.projects.namePlaceholder', 'e.g. Thesis')}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save()
            }}
          />
        </div>
        {iconPickerOpen ? (
          <div className="yolo-project-form-swatches">
            {PROJECT_ICONS.map((item) => (
              <button
                key={item}
                type="button"
                className={`yolo-project-icon-option${item === icon ? ' is-selected' : ''}`}
                aria-pressed={item === icon}
                aria-label={item}
                onClick={() => {
                  setIcon(item)
                  setIconPickerOpen(false)
                }}
              >
                <ObsidianIcon name={item} />
              </button>
            ))}
          </div>
        ) : null}
        <div className="yolo-project-form-swatches">
          {PROJECT_COLOR_IDS.map((item) => (
            <button
              key={item}
              type="button"
              className={`yolo-project-color-option${item === color ? ' is-selected' : ''}`}
              style={projectColorStyle(item)}
              aria-pressed={item === color}
              aria-label={t(`chat.projects.colors.${item}`, item)}
              onClick={() => setColor(item)}
            />
          ))}
        </div>
      </div>

      <div className="yolo-project-form-field">
        <span className="yolo-project-form-label">
          {t('chat.projects.workspace', 'Workspace')}
        </span>
        <WorkspaceCard
          value={workspaceScope}
          color={PROJECT_COLORS[color]}
          onChange={setWorkspaceScope}
        />
      </div>

      <div className="yolo-project-form-field">
        <div className="yolo-project-form-label-row">
          <span className="yolo-project-form-label">
            {t('chat.projects.defaultAgent', 'Default agent')}
          </span>
          {defaultAgent ? (
            <button
              type="button"
              className="yolo-project-form-link"
              onClick={() => setDefaultAgent(undefined)}
            >
              {t('chat.projects.clearDefaultAgent', 'Use the current agent')}
            </button>
          ) : null}
        </div>
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
          {instructionFiles.map((path) => (
            <div key={path} className="yolo-project-card yolo-project-card-row">
              <FileText size={15} className="yolo-project-card-row-icon" />
              <span className="yolo-project-card-row-main is-stacked">
                <span className="yolo-project-card-path">{path}</span>
                <span className="yolo-project-card-row-meta">
                  {t(
                    'chat.projects.instructionsExists',
                    'Exists · every conversation in this project reads it',
                  )}
                </span>
              </span>
              <button
                type="button"
                className="yolo-project-card-button"
                onClick={() => {
                  void app.workspace.openLinkText(path, '', 'tab')
                  onClose()
                }}
              >
                {t('chat.projects.open', 'Open')}
              </button>
            </div>
          ))}
          <span className="yolo-project-form-hint">
            {t(
              'chat.projects.instructionsHint',
              'Every conversation in this project reads these files — the same AGENTS.md that Claude Code and Codex read.',
            )}
          </span>
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
