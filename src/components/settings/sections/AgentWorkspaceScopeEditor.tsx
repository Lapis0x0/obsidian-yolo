import { Check, FileText, Folder, Plus, X } from 'lucide-react'
import { App, TFile, TFolder, Vault } from 'obsidian'
import { useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { AssistantWorkspaceScope } from '../../../types/assistant.types'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { FolderPickerModal } from '../modals/FolderPickerModal'

type AgentWorkspaceScopeEditorProps = {
  app: App
  vault: Vault
  value: AssistantWorkspaceScope | undefined
  onChange: (next: AssistantWorkspaceScope) => void
}

const EMPTY_SCOPE: AssistantWorkspaceScope = {
  enabled: false,
  include: [],
  exclude: [],
}

const normalize = (raw: string): string =>
  raw.replace(/^\/+/, '').replace(/\/+$/, '')

function getPathKind(vault: Vault, path: string): 'folder' | 'file' {
  const abstract = vault.getAbstractFileByPath(normalize(path))
  if (abstract instanceof TFile) return 'file'
  if (abstract instanceof TFolder) return 'folder'
  return 'folder'
}

export function AgentWorkspaceScopeEditor({
  app,
  vault,
  value,
  onChange,
}: AgentWorkspaceScopeEditorProps) {
  const { t } = useLanguage()
  const scope = value ?? EMPTY_SCOPE

  const includeItems = useMemo(
    () => scope.include.map(normalize),
    [scope.include],
  )
  const excludeItems = useMemo(
    () => scope.exclude.map(normalize),
    [scope.exclude],
  )

  const setEnabled = (next: boolean) =>
    onChange({ ...scope, enabled: next })

  const addInclude = () => {
    new FolderPickerModal(
      app,
      vault,
      [...includeItems, ...excludeItems],
      true,
      (picked) => {
        const np = normalize(picked)
        if (includeItems.includes(np)) return
        onChange({ ...scope, include: [...includeItems, np] })
      },
    ).open()
  }

  const addExclude = () => {
    new FolderPickerModal(
      app,
      vault,
      [...includeItems, ...excludeItems],
      true,
      (picked) => {
        const np = normalize(picked)
        if (excludeItems.includes(np)) return
        onChange({ ...scope, exclude: [...excludeItems, np] })
      },
    ).open()
  }

  const removeInclude = (idx: number) => {
    const next = includeItems.slice()
    next.splice(idx, 1)
    onChange({ ...scope, include: next })
  }

  const removeExclude = (idx: number) => {
    const next = excludeItems.slice()
    next.splice(idx, 1)
    onChange({ ...scope, exclude: next })
  }

  return (
    <div className="smtcmp-agent-workspace">
      <div className="smtcmp-agent-workspace-toggle-row">
        <div className="smtcmp-agent-workspace-toggle-main">
          <div className="smtcmp-agent-workspace-toggle-title">
            {t(
              'settings.agent.workspace.enableTitle',
              'Restrict directory access',
            )}
          </div>
          <div className="smtcmp-agent-workspace-toggle-desc">
            {t(
              'settings.agent.workspace.enableDesc',
              'When off, this agent can access the entire vault. When on, the rules below apply.',
            )}
          </div>
        </div>
        <ObsidianToggle value={scope.enabled} onChange={setEnabled} />
      </div>

      <ScopeGroup
        variant="include"
        title={t('settings.agent.workspace.includeTitle', 'Allow')}
        description={t(
          'settings.agent.workspace.includeDesc',
          'Only read/write files under these paths',
        )}
        badge={t('settings.agent.workspace.includeBadge', 'INCLUDE')}
        addLabel={t('common.add', 'Add')}
        items={includeItems}
        disabled={!scope.enabled}
        vault={vault}
        onAdd={addInclude}
        onRemove={removeInclude}
        emptyHint={t(
          'settings.agent.workspace.includeEmpty',
          'Leave empty to allow everything except the exclude list below.',
        )}
      />

      <ScopeGroup
        variant="exclude"
        title={t('settings.agent.workspace.excludeTitle', 'Deny')}
        description={t(
          'settings.agent.workspace.excludeDesc',
          'Excluded from the allow range (higher priority)',
        )}
        badge={t('settings.agent.workspace.excludeBadge', 'EXCLUDE')}
        addLabel={t('common.add', 'Add')}
        items={excludeItems}
        disabled={!scope.enabled}
        vault={vault}
        onAdd={addExclude}
        onRemove={removeExclude}
        emptyHint={t(
          'settings.agent.workspace.excludeEmpty',
          'No exclusions.',
        )}
      />
    </div>
  )
}

type ScopeGroupProps = {
  variant: 'include' | 'exclude'
  title: string
  description: string
  badge: string
  addLabel: string
  items: string[]
  disabled: boolean
  vault: Vault
  onAdd: () => void
  onRemove: (idx: number) => void
  emptyHint: string
}

function ScopeGroup({
  variant,
  title,
  description,
  badge,
  addLabel,
  items,
  disabled,
  vault,
  onAdd,
  onRemove,
  emptyHint,
}: ScopeGroupProps) {
  return (
    <div
      className={`smtcmp-agent-workspace-group smtcmp-agent-workspace-group--${variant}${
        disabled ? ' is-disabled' : ''
      }`}
    >
      <div className="smtcmp-agent-workspace-group-head">
        <span className="smtcmp-agent-workspace-badge">
          {variant === 'include' ? <Check size={11} /> : <X size={11} />}
          <span>{badge}</span>
        </span>
        <div className="smtcmp-agent-workspace-group-title">{title}</div>
        <div className="smtcmp-agent-workspace-group-desc">{description}</div>
        <button
          type="button"
          className="smtcmp-agent-workspace-add"
          onClick={() => onAdd()}
          disabled={disabled}
        >
          <Plus size={12} />
          <span>{addLabel}</span>
        </button>
      </div>
      {items.length === 0 ? (
        <div className="smtcmp-agent-workspace-empty">{emptyHint}</div>
      ) : (
        <div className="smtcmp-agent-workspace-rows">
          {items.map((path, idx) => {
            const kind = getPathKind(vault, path)
            return (
              <div
                key={`${path}__${idx}`}
                className="smtcmp-agent-workspace-row"
              >
                <span className="smtcmp-agent-workspace-row-icon">
                  {kind === 'folder' ? (
                    <Folder size={14} />
                  ) : (
                    <FileText size={14} />
                  )}
                </span>
                <span
                  className="smtcmp-agent-workspace-row-path"
                  title={path || '/'}
                >
                  {path === '' ? '/' : path}
                </span>
                <span className="smtcmp-agent-workspace-row-kind">{kind}</span>
                <button
                  type="button"
                  className="smtcmp-agent-workspace-row-remove"
                  onClick={() => onRemove(idx)}
                  disabled={disabled}
                  aria-label="remove"
                >
                  <X size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
