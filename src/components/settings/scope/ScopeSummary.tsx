import { Ban, Check, FileText, Folder, Layers, X } from 'lucide-react'
import { App, Vault } from 'obsidian'
import { useCallback, useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'

import { ScopeEditorModal } from './ScopeEditorModal'
import {
  ScopePathKind,
  ScopeRule,
  ScopeVariant,
  applyRule,
  buildFolderFileCounts,
  estimateFiles,
  isSameRules,
  normalizeScopePath,
} from './scopeRules'
import { ScopeStatusText } from './ScopeStatusText'
import { resolveScopePathKind } from './scopeVault'

export type ScopeSummaryProps = {
  app: App
  vault: Vault
  rules: ScopeRule[]
  allowFiles: boolean
  variant: ScopeVariant
  /** Files the scope is measured against — `.md`/`.pdf` for RAG, everything
   * for the agent (see `collectScopeCandidateFiles`). */
  candidateFiles: string[]
  /** What "reset" returns to; see `ScopeEditorModal`. */
  defaultRules: ScopeRule[]
  onChange: (rules: ScopeRule[]) => void
  disabled?: boolean
}

function ScopePathCrumb({ path }: { path: string }) {
  if (path === '') {
    return <span className="yolo-scope-crumb-leaf">/</span>
  }
  const segments = path.split('/')
  const leaf = segments.pop() ?? path
  return (
    <>
      {segments.map((segment, index) => (
        <span
          // Path segments repeat across a path, so the index is part of the
          // identity here.
          key={`${index}-${segment}`}
          className="yolo-scope-crumb-segment"
        >
          {segment}
          <span className="yolo-scope-crumb-separator">/</span>
        </span>
      ))}
      <span className="yolo-scope-crumb-leaf">{leaf}</span>
    </>
  )
}

/**
 * The settings-page face of a scope: the same status sentence the editor
 * shows, the minimal rule list behind it, and the way into the editor.
 */
export function ScopeSummary({
  app,
  vault,
  rules,
  allowFiles,
  variant,
  candidateFiles,
  defaultRules,
  onChange,
  disabled = false,
}: ScopeSummaryProps) {
  const { t } = useLanguage()

  const pathKind = useCallback(
    (path: string): ScopePathKind => resolveScopePathKind(vault, path),
    [vault],
  )
  const estimate = useMemo(
    () => estimateFiles(candidateFiles, rules),
    [candidateFiles, rules],
  )
  const folderCounts = useMemo(
    () => buildFolderFileCounts(candidateFiles),
    [candidateFiles],
  )
  const sortedRules = useMemo(
    () =>
      [...rules].sort((a, b) =>
        normalizeScopePath(a.path).localeCompare(normalizeScopePath(b.path)),
      ),
    [rules],
  )

  const openEditor = () => {
    new ScopeEditorModal(app, vault, {
      rules,
      defaultRules,
      allowFiles,
      variant,
      candidateFiles,
      onSave: onChange,
    }).open()
  }

  return (
    <div className={`yolo-scope-summary${disabled ? ' is-disabled' : ''}`}>
      <div className="yolo-scope-summary-head">
        <div className="yolo-scope-summary-copy">
          <div className="yolo-scope-summary-title">
            {t('settings.scope.currentRules', '当前规则')}
          </div>
          <div className="yolo-scope-status yolo-scope-status--inline">
            <ScopeStatusText
              rules={rules}
              variant={variant}
              pathKind={pathKind}
              estimate={estimate}
            />
          </div>
        </div>
        <button
          type="button"
          className="yolo-scope-edit-button mod-cta"
          disabled={disabled}
          onClick={openEditor}
        >
          <Layers size={14} />
          <span>{t('settings.scope.editRange', '编辑范围')}</span>
        </button>
      </div>

      <div className="yolo-scope-rules">
        {sortedRules.length === 0 ? (
          <div className="yolo-scope-rules-empty">
            {t(
              `settings.scope.noRules.${variant}`,
              variant === 'rag'
                ? '没有规则，索引整个库'
                : '没有规则，整个库可用',
            )}
          </div>
        ) : (
          sortedRules.map((rule) => {
            const path = normalizeScopePath(rule.path)
            const kind = pathKind(path)
            return (
              <div
                key={`${rule.kind}:${path}`}
                className={`yolo-scope-rule-row is-${rule.kind}`}
              >
                <span className={`yolo-scope-badge is-${rule.kind}`}>
                  {rule.kind === 'include' ? (
                    <Check size={12} />
                  ) : (
                    <Ban size={12} />
                  )}
                  {t(
                    `settings.scope.${rule.kind}`,
                    rule.kind === 'include' ? '包含' : '排除',
                  )}
                </span>
                <span className="yolo-scope-rule-icon" aria-hidden="true">
                  {kind === 'file' ? (
                    <FileText size={14} />
                  ) : (
                    <Folder size={14} />
                  )}
                </span>
                <span className="yolo-scope-rule-path" title={path || '/'}>
                  <ScopePathCrumb path={path} />
                </span>
                <span className="yolo-scope-rule-count">
                  {kind === 'file'
                    ? t('settings.scope.fileLabel', '文件')
                    : t('settings.scope.fileCount', '{{n}} 个文件').replace(
                        '{{n}}',
                        String(folderCounts.get(path) ?? 0),
                      )}
                </span>
                <button
                  type="button"
                  className="yolo-scope-rule-remove"
                  aria-label={t('common.remove', '移除')}
                  disabled={disabled}
                  onClick={() => onChange(applyRule(rules, path, null))}
                >
                  <X size={14} />
                </button>
              </div>
            )
          })
        )}
        <div className="yolo-scope-rules-footer">
          <span>
            {t('settings.scope.rulesCount', '{{n}} 条规则').replace(
              '{{n}}',
              String(rules.length),
            )}
          </span>
          {/* Never a permanently-present dead control: already at the default
              there is nothing to reset to, so the button is absent. */}
          {isSameRules(rules, defaultRules) ? null : (
            <button
              type="button"
              className="yolo-scope-rules-clear"
              disabled={disabled}
              title={t(
                'settings.scope.resetTitle',
                '恢复默认范围，清除所有自定义规则',
              )}
              onClick={() => onChange(defaultRules)}
            >
              {t('settings.scope.reset', '重置')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
