import { App, TFile, TFolder, Vault } from 'obsidian'
import React, { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { ReactModal } from '../../common/ReactModal'
import { listAllFolderPaths } from '../../../utils/rag-utils'

type FolderPickerModalProps = {
  vault: Vault
  existing: string[]
  allowFiles?: boolean
  onPick: (folderPath: string) => void
  onClose: () => void
}

export class FolderPickerModal extends ReactModal<FolderPickerModalProps> {
  constructor(
    app: App,
    vault: Vault,
    existing: string[],
    allowFiles: boolean,
    onPick: (folderPath: string) => void,
  ) {
    super({
      app,
      Component: FolderPickerModalComponent,
      props: { vault, existing, onPick, allowFiles },
      options: { title: allowFiles ? '选择文件或文件夹' : '选择文件夹' },
    })
  }
}

function FolderPickerModalComponent({ vault, existing, onPick, onClose, allowFiles }: FolderPickerModalProps) {
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const allFolders = useMemo(() => listAllFolderPaths(vault), [vault])
  const allFiles = useMemo(() => {
    if (!allowFiles) return [] as TFile[]
    try {
      const all = vault.getAllLoadedFiles?.()
      if (all && Array.isArray(all)) {
        return all.filter((f): f is TFile => f instanceof TFile)
      }
    } catch {}
    return vault.getMarkdownFiles?.() ?? []
  }, [vault, allowFiles])

  type Node = { path: string; name: string; children: Node[]; type: 'folder' | 'file' }

  const roots: Node[] = useMemo(() => {
    // build nodes
    const nodes = new Map<string, Node>()
    const ensure = (p: string): Node => {
      const norm = p
      if (nodes.has(norm)) return nodes.get(norm)!
      const name = norm === '' ? '/' : norm.split('/').pop()!
      const n: Node = { path: norm, name, children: [], type: 'folder' }
      nodes.set(norm, n)
      return n
    }

    for (const p of allFolders) {
      ensure(p)
    }
    // attach parents
    const parentOf = (p: string) => {
      if (!p || !p.includes('/')) return ''
      return p.substring(0, p.lastIndexOf('/'))
    }
    for (const p of allFolders) {
      if (p === '') continue
      const parent = ensure(parentOf(p))
      const node = ensure(p)
      parent.children.push(node)
    }

    if (allowFiles) {
      for (const file of allFiles) {
        const folderPath = file.parent?.path
          ? file.parent.path.replace(/^\/+/, '').replace(/\/+$/, '')
          : ''
        const parentNode = ensure(folderPath)
        parentNode.children.push({
          path: file.path,
          name: file.name,
          children: [],
          type: 'file',
        })
      }
    }

    const sortRec = (arr: Node[]) => {
      arr.sort((a, b) => a.name.localeCompare(b.name))
      for (const n of arr) sortRec(n.children)
    }
    const r = ensure('').children
    sortRec(r)
    return r
  }, [allFolders, allFiles, allowFiles])

  // filter tree by query (show matches and their ancestors)
  const filteredRoots: Node[] = useMemo(() => {
    const lower = q.trim().toLowerCase()
    if (!lower) return roots
    const filterRec = (node: Node): Node | null => {
      const selfMatch = node.path.toLowerCase().includes(lower) || node.name.toLowerCase().includes(lower)
      const childMatches = node.children
        .map(filterRec)
        .filter((x): x is Node => x !== null)
      if (selfMatch || childMatches.length > 0) {
        return { ...node, children: childMatches }
      }
      return null
    }
    const out = roots
      .map(filterRec)
      .filter((x): x is Node => x !== null)
    return out
  }, [q, roots])

  // auto-expand when searching so matched nodes are visible
  React.useEffect(() => {
    const lower = q.trim().toLowerCase()
    if (!lower) return
    const collect = (ns: Node[], acc: Set<string>) => {
      for (const n of ns) {
        acc.add(n.path)
        collect(n.children, acc)
      }
    }
    const next = new Set<string>(expanded)
    collect(filteredRoots, next)
    setExpanded(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filteredRoots])

  const toggle = (p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }

  // hover 态通过 CSS :hover 处理
  const renderNode = (node: Node, depth: number) => {
    const hasChildren = node.type === 'folder' && node.children.length > 0
    const isOpen = node.type === 'folder' && expanded.has(node.path)
    const isSelected = existing.includes(node.path)
    const isCoveredByAncestor = existing.some((p) => {
      if (p === '') return true
      if (p === node.path) return true
      return node.path.startsWith(p + '/')
    })
    const isDisabled = isSelected || (node.type === 'file' ? isCoveredByAncestor : isCoveredByAncestor)
    return (
      <li key={node.path}>
        <div
          className={
            `smtcmp-provider-header smtcmp-folder-row smtcmp-indent-folder smtcmp-depth smtcmp-depth-${Math.min(10, Math.max(0, depth))}` +
            (isDisabled ? ' is-disabled' : '')
          }
          onClick={() => {
            if (isDisabled) return
            onPick(node.path)
            onClose()
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (isDisabled) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onPick(node.path)
              onClose()
            }
          }}
        >
          <div
            className={`smtcmp-provider-expand-btn ${hasChildren ? '' : 'no-children'}`}
            onClick={(e) => {
              e.stopPropagation()
              if (hasChildren) toggle(node.path)
            }}
          >
            {hasChildren ? (isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />) : <span className="smtcmp-icon-placeholder" />}
          </div>
          <div className="smtcmp-provider-info">
            <span
              className="smtcmp-folder-name"
              title={isSelected ? '已选择' : isCoveredByAncestor ? '已被父级覆盖' : node.path || '/'}
            >
              {node.name}
            </span>
          </div>
        </div>
        {hasChildren && isOpen && (
          <ul className="smtcmp-list-reset">
            {node.children.map((c) => renderNode(c, depth + 1))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <div className="smtcmp-folder-picker">
      <input
        type="text"
        placeholder="搜索文件夹..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="svelte-obsidian-text-input"
      />

      <div className="smtcmp-scroll-panel">
        {filteredRoots.length === 0 ? (
          <div className="smtcmp-folder-empty">未找到匹配的文件夹</div>
        ) : (
          <ul className="smtcmp-list-reset">
            {filteredRoots.map((n) => renderNode(n, 0))}
          </ul>
        )}
      </div>

      <div className="smtcmp-actions-right-gap-8">
        <button onClick={onClose} className="mod-cancel">关闭</button>
      </div>
    </div>
  )
}
