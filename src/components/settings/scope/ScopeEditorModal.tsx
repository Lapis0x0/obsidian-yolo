import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Filter,
  Folder,
  FolderOpen,
  Globe,
  Search,
  Target,
} from 'lucide-react'
import { App, Menu, Platform, Vault } from 'obsidian'
import React, { useCallback, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { getNodeDocument } from '../../../utils/dom/window-context'
import { listAllFolderPaths } from '../../../utils/rag-utils'
import { ReactModal } from '../../common/ReactModal'

import {
  ScopePathKind,
  ScopeRule,
  ScopeRuleKind,
  ScopeVariant,
  applyRule,
  buildFolderFileCounts,
  effectiveState,
  estimateFiles,
  findRuleKind,
  hasIncludeRule,
  isSameRules,
  normalizeScopePath,
  ruleDisabledReason,
} from './scopeRules'
import { ScopeStatusText } from './ScopeStatusText'

type ScopeEditorModalProps = {
  vault: Vault
  rules: ScopeRule[]
  /** What "reset" returns to (RAG: only the YOLO folder kept out; agent: nothing). */
  defaultRules: ScopeRule[]
  allowFiles: boolean
  variant: ScopeVariant
  candidateFiles: string[]
  onSave: (rules: ScopeRule[]) => void
}

export type ScopeEditorModalOptions = Omit<ScopeEditorModalProps, 'vault'>

export class ScopeEditorModal extends ReactModal<ScopeEditorModalProps> {
  constructor(app: App, vault: Vault, options: ScopeEditorModalOptions) {
    super({
      app,
      Component: ScopeEditorModalComponent,
      props: { vault, ...options },
      options: { className: 'yolo-scope-editor-modal' },
    })
  }
}

type ScopeNode = {
  path: string
  name: string
  kind: ScopePathKind
  children: ScopeNode[]
}

function parentFolderOf(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator === -1 ? '' : path.slice(0, separator)
}

function buildScopeTree(
  folderPaths: readonly string[],
  filePaths: readonly string[],
): ScopeNode[] {
  const nodes = new Map<string, ScopeNode>()
  const ensureFolder = (path: string): ScopeNode => {
    const existing = nodes.get(path)
    if (existing) return existing
    const node: ScopeNode = {
      path,
      name: path === '' ? '/' : (path.split('/').pop() ?? path),
      kind: 'folder',
      children: [],
    }
    nodes.set(path, node)
    if (path !== '') {
      ensureFolder(parentFolderOf(path)).children.push(node)
    }
    return node
  }

  ensureFolder('')
  for (const path of [...folderPaths].sort((a, b) => a.length - b.length)) {
    if (path === '') continue
    ensureFolder(path)
  }
  for (const path of filePaths) {
    const normalized = normalizeScopePath(path)
    ensureFolder(parentFolderOf(normalized)).children.push({
      path: normalized,
      name: normalized.split('/').pop() ?? normalized,
      kind: 'file',
      children: [],
    })
  }

  const sortRecursively = (list: ScopeNode[]) => {
    list.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const node of list) sortRecursively(node.children)
  }
  const roots = nodes.get('')?.children ?? []
  sortRecursively(roots)
  return roots
}

function filterScopeTree(
  nodes: readonly ScopeNode[],
  query: string,
  onlyWithRules: boolean,
  rules: readonly ScopeRule[],
): ScopeNode[] {
  if (!query && !onlyWithRules) return [...nodes]
  const lowered = query.toLowerCase()
  const visit = (node: ScopeNode): ScopeNode | null => {
    const children = node.children
      .map(visit)
      .filter((child): child is ScopeNode => child !== null)
    const matchesQuery =
      !query ||
      node.name.toLowerCase().includes(lowered) ||
      node.path.toLowerCase().includes(lowered)
    const matchesRuleFilter =
      !onlyWithRules || findRuleKind(rules, node.path) !== null
    const selfVisible = matchesQuery && matchesRuleFilter
    if (!selfVisible && children.length === 0) return null
    return { ...node, children }
  }
  return nodes.map(visit).filter((node): node is ScopeNode => node !== null)
}

function HighlightedName({ name, query }: { name: string; query: string }) {
  if (!query) return <>{name}</>
  const index = name.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return <>{name}</>
  return (
    <>
      {name.slice(0, index)}
      <mark className="yolo-scope-highlight">
        {name.slice(index, index + query.length)}
      </mark>
      {name.slice(index + query.length)}
    </>
  )
}

function ScopeEditorModalComponent({
  vault,
  rules: initialRules,
  defaultRules,
  allowFiles,
  variant,
  candidateFiles,
  onSave,
  onClose,
}: ScopeEditorModalProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const isMobile = Platform.isMobile
  const [rules, setRules] = useState<ScopeRule[]>(initialRules)
  const [query, setQuery] = useState('')
  const [onlyWithRules, setOnlyWithRules] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [pulseCount, setPulseCount] = useState(0)
  const rulesRef = useRef(rules)
  rulesRef.current = rules

  const folderPaths = useMemo(() => listAllFolderPaths(vault), [vault])
  const treeFiles = useMemo(
    () => (allowFiles ? candidateFiles : []),
    [allowFiles, candidateFiles],
  )
  const roots = useMemo(
    () => buildScopeTree(folderPaths, treeFiles),
    [folderPaths, treeFiles],
  )
  const folderCounts = useMemo(
    () => buildFolderFileCounts(candidateFiles),
    [candidateFiles],
  )
  const pathKinds = useMemo(() => {
    const map = new Map<string, ScopePathKind>()
    const visit = (list: readonly ScopeNode[]) => {
      for (const node of list) {
        map.set(node.path, node.kind)
        visit(node.children)
      }
    }
    visit(roots)
    return map
  }, [roots])
  const pathKind = useCallback(
    (path: string): ScopePathKind =>
      pathKinds.get(normalizeScopePath(path)) ?? 'folder',
    [pathKinds],
  )

  const commitRules = useCallback((next: ScopeRule[]) => {
    const hadInclude = hasIncludeRule(rulesRef.current)
    setRules(next)
    if (!hadInclude && hasIncludeRule(next)) {
      setPulseCount((count) => count + 1)
    }
  }, [])

  const setMark = useCallback(
    (path: string, kind: ScopeRuleKind | null) => {
      commitRules(applyRule(rulesRef.current, path, kind))
    },
    [commitRules],
  )

  const toggleMark = useCallback(
    (path: string, kind: ScopeRuleKind) => {
      const current = findRuleKind(rulesRef.current, path)
      setMark(path, current === kind ? null : kind)
    },
    [setMark],
  )

  const describeReason = useCallback(
    (path: string, kind: ScopeRuleKind): string | null => {
      const reason = ruleDisabledReason(path, kind, rules)
      if (!reason) return null
      const ancestorName =
        reason.ancestor === ''
          ? '/'
          : (reason.ancestor.split('/').pop() ?? reason.ancestor)
      return t(
        reason.kind === 'excludedAncestor'
          ? 'settings.scope.reasonExcludedAncestor'
          : 'settings.scope.reasonIncludedAncestor',
        reason.kind === 'excludedAncestor'
          ? '父级「{{name}}」已排除'
          : '已由父级「{{name}}」包含',
      ).replace('{{name}}', ancestorName)
    },
    [rules, t],
  )

  // Never `instanceof`-sniff the anchor: in a popout the row element comes
  // from another realm, so a tagged union is the only reliable discriminator.
  const openRowMenu = useCallback(
    (
      path: string,
      anchor:
        | { at: 'pointer'; event: MouseEvent }
        | { at: 'element'; element: HTMLElement },
    ) => {
      const menu = new Menu()
      const own = findRuleKind(rulesRef.current, path)
      const kinds: ScopeRuleKind[] = ['include', 'exclude']
      for (const kind of kinds) {
        const reason = describeReason(path, kind)
        const label = t(
          `settings.scope.${kind}`,
          kind === 'include' ? '包含' : '排除',
        )
        menu.addItem((item) => {
          item
            .setTitle(reason ? `${label} · ${reason}` : label)
            .setIcon(kind === 'include' ? 'check' : 'ban')
            .setChecked(own === kind ? true : null)
            .setDisabled(reason !== null)
            .onClick(() => {
              if (reason) return
              setMark(path, kind)
            })
        })
      }
      if (own) {
        menu.addItem((item) => {
          item
            .setTitle(t('settings.scope.clearMark', '清除标记'))
            .setIcon('x')
            .onClick(() => setMark(path, null))
        })
      }
      if (anchor.at === 'element') {
        const rect = anchor.element.getBoundingClientRect()
        menu.showAtPosition(
          { x: rect.left, y: rect.bottom },
          getNodeDocument(anchor.element),
        )
      } else {
        menu.showAtMouseEvent(anchor.event)
      }
    },
    [describeReason, setMark, t],
  )

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const setExpandedState = useCallback((path: string, open: boolean) => {
    setExpanded((previous) => {
      if (previous.has(path) === open) return previous
      const next = new Set(previous)
      if (open) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const trimmedQuery = query.trim()
  const filteredRoots = useMemo(
    () => filterScopeTree(roots, trimmedQuery, onlyWithRules, rules),
    [roots, trimmedQuery, onlyWithRules, rules],
  )
  // Searching or filtering shows every surviving branch without touching the
  // user's own expansion set, so clearing the box restores what they had open.
  const forceExpanded = trimmedQuery !== '' || onlyWithRules

  const estimate = useMemo(
    () => estimateFiles(candidateFiles, rules),
    [candidateFiles, rules],
  )
  const includeCount = rules.filter((rule) => rule.kind === 'include').length
  const excludeCount = rules.length - includeCount
  const showsOnlyMode = hasIncludeRule(rules)

  const renderNodes = (nodes: readonly ScopeNode[]): React.ReactNode => (
    <ul className="yolo-scope-tree-list">
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0
        const isOpen = forceExpanded || expanded.has(node.path)
        const own = findRuleKind(rules, node.path)
        const effective = effectiveState(node.path, rules)
        const followsName =
          !own && effective.source !== null
            ? effective.source === ''
              ? '/'
              : (effective.source.split('/').pop() ?? effective.source)
            : null
        const rowClassNames = [
          'yolo-scope-row',
          effective.state === 'include'
            ? 'is-effective-include'
            : 'is-effective-exclude',
          own ? 'has-rule' : '',
          node.kind === 'file' ? 'is-file' : '',
        ]
          .filter(Boolean)
          .join(' ')

        return (
          <li key={node.path} className="yolo-scope-tree-item">
            <div
              className={rowClassNames}
              role="treeitem"
              aria-expanded={hasChildren ? isOpen : undefined}
              aria-selected={own !== null}
              tabIndex={0}
              onClick={(event) => {
                if (!isMobile) return
                openRowMenu(node.path, {
                  at: 'pointer',
                  event: event.nativeEvent,
                })
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  openRowMenu(node.path, {
                    at: 'element',
                    element: event.currentTarget,
                  })
                  return
                }
                if (event.key === 'ArrowRight' && hasChildren) {
                  event.preventDefault()
                  setExpandedState(node.path, true)
                  return
                }
                if (event.key === 'ArrowLeft' && hasChildren) {
                  event.preventDefault()
                  setExpandedState(node.path, false)
                }
              }}
            >
              <button
                type="button"
                className={`yolo-scope-row-toggle${hasChildren ? '' : ' is-blank'}`}
                tabIndex={-1}
                aria-hidden={!hasChildren}
                onClick={(event) => {
                  event.stopPropagation()
                  if (hasChildren) toggleExpanded(node.path)
                }}
              >
                {hasChildren ? (
                  isOpen ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )
                ) : null}
              </button>
              <span className="yolo-scope-row-icon" aria-hidden="true">
                {node.kind === 'file' ? (
                  <FileText size={14} />
                ) : isOpen && hasChildren ? (
                  <FolderOpen size={14} />
                ) : (
                  <Folder size={14} />
                )}
              </span>
              <span className="yolo-scope-row-name" title={node.path}>
                <HighlightedName name={node.name} query={trimmedQuery} />
              </span>
              {node.kind === 'folder' ? (
                <span className="yolo-scope-row-count">
                  {folderCounts.get(node.path) ?? 0}
                </span>
              ) : null}
              {followsName && !isMobile ? (
                <span className="yolo-scope-row-follows">
                  {t('settings.scope.follows', '跟随「{{name}}」').replace(
                    '{{name}}',
                    followsName,
                  )}
                </span>
              ) : null}
              {isMobile ? (
                <span className="yolo-scope-row-state">
                  {own ? (
                    <span className={`yolo-scope-badge is-${own}`}>
                      {t(
                        `settings.scope.${own}`,
                        own === 'include' ? '包含' : '排除',
                      )}
                    </span>
                  ) : followsName ? (
                    <span className="yolo-scope-row-follows">
                      {t('settings.scope.follows', '跟随「{{name}}」').replace(
                        '{{name}}',
                        followsName,
                      )}
                    </span>
                  ) : null}
                  <ChevronRight size={14} />
                </span>
              ) : (
                <span className="yolo-scope-row-marks">
                  {(['include', 'exclude'] as const).map((kind) => {
                    const reason = describeReason(node.path, kind)
                    const label = t(
                      `settings.scope.${kind}`,
                      kind === 'include' ? '包含' : '排除',
                    )
                    return (
                      <button
                        key={kind}
                        type="button"
                        className={`yolo-scope-mark is-${kind}${own === kind ? ' is-active' : ''}`}
                        disabled={reason !== null}
                        title={
                          reason ??
                          (own === kind
                            ? t(
                                'settings.scope.clickAgainToClear',
                                '再点一次取消',
                              )
                            : label)
                        }
                        onClick={(event) => {
                          event.stopPropagation()
                          toggleMark(node.path, kind)
                        }}
                      >
                        {kind === 'include' ? (
                          <Check size={12} />
                        ) : (
                          <Ban size={12} />
                        )}
                        <span>{label}</span>
                      </button>
                    )
                  })}
                </span>
              )}
            </div>
            {hasChildren && isOpen ? (
              <div className="yolo-scope-children">
                {renderNodes(node.children)}
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )

  return (
    <div className="yolo-scope-editor">
      <div className="yolo-scope-editor-head">
        <div className="yolo-scope-editor-title">
          {t(
            `settings.scope.modalTitle.${variant}`,
            variant === 'rag' ? '编辑索引范围' : '编辑工作区作用域',
          )}
        </div>
        <div className="yolo-scope-editor-subtitle">
          {t(
            `settings.scope.modalSubtitle.${variant}`,
            variant === 'rag'
              ? '悬停任意文件夹标记 包含 / 排除；再点一次取消。'
              : '可以精确到单个文件；文件默认跟随所在文件夹。',
          )}
        </div>
      </div>

      <div
        key={pulseCount}
        className={`yolo-scope-status yolo-scope-status--block${
          showsOnlyMode ? ' is-only' : ''
        }${pulseCount > 0 ? ' is-flip' : ''}`}
      >
        <span className="yolo-scope-status-icon" aria-hidden="true">
          {showsOnlyMode ? <Target size={14} /> : <Globe size={14} />}
        </span>
        <span className="yolo-scope-status-text">
          <ScopeStatusText
            rules={rules}
            variant={variant}
            pathKind={pathKind}
            estimate={estimate}
          />
        </span>
        {isSameRules(rules, defaultRules) ? null : (
          <button
            type="button"
            className="yolo-scope-status-reset"
            title={t(
              'settings.scope.resetTitle',
              '恢复默认范围，清除所有自定义规则',
            )}
            onClick={() => commitRules(defaultRules)}
          >
            {t('settings.scope.reset', '重置')}
          </button>
        )}
      </div>

      <div className="yolo-scope-tools">
        <label className="yolo-scope-search">
          <Search size={14} />
          <input
            type="text"
            value={query}
            placeholder={t(
              allowFiles
                ? 'settings.scope.searchFoldersOrFiles'
                : 'settings.scope.searchFolders',
              allowFiles ? '搜索文件夹或文件…' : '搜索文件夹…',
            )}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={`yolo-scope-filter${onlyWithRules ? ' is-active' : ''}`}
          aria-pressed={onlyWithRules}
          onClick={() => setOnlyWithRules((previous) => !previous)}
        >
          <Filter size={14} />
          <span className="yolo-scope-filter-label">
            {t('settings.scope.onlyWithRules', '只看有规则的')}
          </span>
        </button>
      </div>

      <div className="yolo-scope-tree" role="tree">
        {filteredRoots.length > 0 ? (
          renderNodes(filteredRoots)
        ) : (
          <div className="yolo-scope-tree-empty">
            {onlyWithRules && trimmedQuery === ''
              ? t('settings.scope.noRuleYet', '还没有任何规则')
              : t(
                  `settings.scope.noMatch.${variant}`,
                  allowFiles ? '没有匹配的文件夹或文件' : '没有匹配的文件夹',
                )}
          </div>
        )}
      </div>

      <div className="yolo-scope-editor-footer">
        <div className="yolo-scope-editor-counts">
          <span className="yolo-scope-badge is-include">
            <Check size={12} />
            {`${t('settings.scope.include', '包含')} ${includeCount}`}
          </span>
          <span className="yolo-scope-badge is-exclude">
            <Ban size={12} />
            {`${t('settings.scope.exclude', '排除')} ${excludeCount}`}
          </span>
          <span className="yolo-scope-editor-estimate">
            {`≈ ${estimate.matched} / ${estimate.total}`}
          </span>
        </div>
        <div className="yolo-scope-editor-actions">
          <button type="button" onClick={onClose}>
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            className="mod-cta"
            onClick={() => {
              onSave(rules)
              onClose()
            }}
          >
            {t('common.save', '保存')}
          </button>
        </div>
      </div>
    </div>
  )
}
