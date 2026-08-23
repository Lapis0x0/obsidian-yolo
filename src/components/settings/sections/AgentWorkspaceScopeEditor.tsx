import { App, Vault } from 'obsidian'
import { useCallback, useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { AssistantWorkspaceScope } from '../../../types/assistant.types'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import {
  type ScopeRule,
  rulesFromWorkspaceScope,
  workspaceScopeFromRules,
} from '../scope/scopeRules'
import { ScopeSummary } from '../scope/ScopeSummary'
import { collectScopeCandidateFiles } from '../scope/scopeVault'

/** An agent scope resets to "nothing kept out, nothing required". */
const DEFAULT_AGENT_SCOPE_RULES: ScopeRule[] = []

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

export function AgentWorkspaceScopeEditor({
  app,
  vault,
  value,
  onChange,
}: AgentWorkspaceScopeEditorProps) {
  const { t } = useLanguage()
  const scope = value ?? EMPTY_SCOPE

  const rules = useMemo(() => rulesFromWorkspaceScope(scope), [scope])
  const candidateFiles = useMemo(
    () => collectScopeCandidateFiles(vault),
    [vault],
  )

  const handleRulesChange = useCallback(
    (nextRules: ScopeRule[]) => {
      onChange({ ...scope, ...workspaceScopeFromRules(nextRules) })
    },
    [onChange, scope],
  )

  return (
    <div className="yolo-agent-workspace">
      <div className="yolo-agent-workspace-toggle-row">
        <div className="yolo-agent-workspace-toggle-main">
          <div className="yolo-agent-workspace-toggle-title">
            {t(
              'settings.agent.workspace.enableTitle',
              'Limit autonomous working range',
            )}
          </div>
          <div className="yolo-agent-workspace-toggle-desc">
            {t(
              'settings.agent.workspace.enableDesc',
              'When off, the agent can browse and edit anywhere in the vault on its own. When on, its own browsing and edits stay within the ranges below — files you @ mention or have open are never restricted.',
            )}
          </div>
        </div>
        <ObsidianToggle
          value={scope.enabled}
          onChange={(next) => onChange({ ...scope, enabled: next })}
        />
      </div>

      <ScopeSummary
        app={app}
        vault={vault}
        rules={rules}
        allowFiles
        variant="agent"
        candidateFiles={candidateFiles}
        defaultRules={DEFAULT_AGENT_SCOPE_RULES}
        onChange={handleRulesChange}
        disabled={!scope.enabled}
      />

      <div className="yolo-agent-workspace-footnote">
        {t(
          'settings.agent.workspace.toolBypassNotice',
          'Agents with terminal commands or third-party MCP tools enabled can go around this range — it is not a security boundary.',
        )}
      </div>
    </div>
  )
}
