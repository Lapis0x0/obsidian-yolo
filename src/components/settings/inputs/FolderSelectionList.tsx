import { App, TFile, TFolder, Vault } from 'obsidian'
import React, { useCallback, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { FolderPickerModal } from '../modals/FolderPickerModal'

export type FolderSelectionListProps = {
  app: App
  vault: Vault
  value: string[]
  onChange: (folders: string[]) => void
  title?: string
  placeholder?: string
  allowFiles?: boolean
}

/**
 * A minimal folder selection list with add/remove and drag-and-drop reordering.
 * Style aims to resemble Obsidian's file list while keeping zero external deps.
 */
export function FolderSelectionList({
  app,
  vault,
  value,
  onChange,
  title,
  placeholder,
  allowFiles = false,
}: FolderSelectionListProps) {
  const { t } = useLanguage()
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const overIndexRef = useRef<number | null>(null)

  // Normalize any incoming folder values to avoid duplicates like '/', '**', 'path/'
  const normalize = useCallback((p: string): string => {
    if (!p) return ''
    const trimmed = p.replace(/^\/+/, '').replace(/\/+$/, '')
    if (allowFiles) {
      const abstract = vault.getAbstractFileByPath(trimmed)
      if (abstract instanceof TFile) {
        return abstract.path
      }
      if (abstract instanceof TFolder) {
        return abstract.path.replace(/^\/+/, '').replace(/\/+$/, '')
      }
      if (trimmed.includes('*')) return ''
      return trimmed
    }

    if (trimmed === '' || trimmed === '**') return ''
    const m1 = trimmed.match(/^(.*)\/\*\*\/(?:\*|\*\.md)$/)
    if (m1) return m1[1].replace(/^\/+/, '').replace(/\/+$/, '')
    const m2 = trimmed.match(/^(.*)\/\*\.md$/)
    if (m2) return m2[1].replace(/^\/+/, '').replace(/\/+$/, '')
    if (trimmed.includes('*')) return ''
    return trimmed
  }, [allowFiles, vault])

  const items = useMemo(() => value.map(normalize), [normalize, value])

  const absorbByParent = (list: string[]): string[] => {
    // Keep shortest ancestors; remove descendants covered by any kept parent
    const sorted = [...list]
      .map((p) => p.replace(/^\/+/, '').replace(/\/+$/, ''))
      .sort((a, b) => a.length - b.length)
    const kept: string[] = []
    const isAncestor = (parent: string, child: string) => {
      if (parent === '') return true
      if (parent === child) return true
      return child.startsWith(parent + '/')
    }
    for (const cand of sorted) {
      if (kept.some((k) => isAncestor(k, cand))) continue
      kept.push(cand)
    }
    return kept
  }

  const handleAdd = () => {
    new FolderPickerModal(app, vault, items, allowFiles, (picked) => {
      const np = normalize(picked)
      if (items.includes(np)) return
      const next = absorbByParent([...items, np])
      onChange(next)
    }).open()
  }

  const handleClear = () => {
    if (items.length === 0) return
    onChange([])
  }

  const handleRemove = (idx: number) => {
    const next = items.slice()
    next.splice(idx, 1)
    onChange(next)
  }

  const moveItem = (from: number, to: number) => {
    if (
      from === to ||
      from < 0 ||
      to < 0 ||
      from >= items.length ||
      to >= items.length
    )
      return
    const next = items.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }

  const onDragStart = (idx: number) => (e: React.DragEvent) => {
    setDragIndex(idx)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(idx))
  }
  const onDragOver = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault()
    overIndexRef.current = idx
  }
  const onDrop = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault()
    const fromStr = e.dataTransfer.getData('text/plain')
    const from = fromStr ? parseInt(fromStr, 10) : dragIndex
    if (from == null) return
    moveItem(from, idx)
    setDragIndex(null)
    overIndexRef.current = null
  }
  const onDragEnd = () => {
    setDragIndex(null)
    overIndexRef.current = null
  }

  // Click handler for the container (bordered box)
  const onContainerClick = (_e: React.MouseEvent<HTMLDivElement>) => {
    // Clicking anywhere in the container opens the picker.
    handleAdd()
  }

  return (
    <div className="smtcmp-folder-selection">
      <div className="smtcmp-folder-selection-toolbar">
        <div className="smtcmp-folder-selection-title">
          {title ?? t('settings.rag.selectedFolders', '已选择的文件夹')}
        </div>
        <div className="smtcmp-folder-selection-actions">
          <button
            aria-label={t('common.add', '添加')}
            title={t('common.add', '添加')}
            onClick={() => handleAdd()}
            className="smtcmp-folder-selection-btn"
          >
            +
          </button>
          <button
            aria-label={t('common.clear', '清空')}
            title={t('common.clear', '清空')}
            onClick={() => handleClear()}
            className="smtcmp-folder-selection-btn"
          >
            {t('common.clear', '清空')}
          </button>
        </div>
      </div>

      <div
        onClick={onContainerClick}
        className="smtcmp-folder-selection-picker"
      >
        {items.length === 0 ? (
          <div className="smtcmp-folder-selection-empty">
            {placeholder ??
              (allowFiles
                ? t(
                    'settings.rag.selectFilesOrFoldersPlaceholder',
                    '点击此处选择文件或文件夹（留空表示全库）',
                  )
                : t(
                    'settings.rag.selectFoldersPlaceholder',
                    '点击此处选择文件夹（留空则默认包含全部）',
                  ))}
          </div>
        ) : (
          <div className="smtcmp-folder-selection-list">
            {items.map((p, idx) => (
              <div
                key={`${p}__${idx}`}
                draggable
                onDragStart={onDragStart(idx)}
                onDragOver={onDragOver(idx)}
                onDrop={onDrop(idx)}
                onDragEnd={onDragEnd}
                className="smtcmp-folder-selection-chip"
              >
                <span className="smtcmp-folder-selection-chip-handle">⋮⋮</span>
                <span className="smtcmp-folder-selection-chip-path">
                  {p === '' ? '/' : p}
                </span>
                <span
                  role="button"
                  aria-label={t('common.remove', '移除')}
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleRemove(idx)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      e.stopPropagation()
                      handleRemove(idx)
                    }
                  }}
                  className="smtcmp-folder-selection-chip-remove"
                >
                  ×
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
