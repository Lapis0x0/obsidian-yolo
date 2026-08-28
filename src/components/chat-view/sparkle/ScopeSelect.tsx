import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronDown, ChevronUp } from 'lucide-react'
import React, { useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { YoloDropdownContent } from '../../common/popover'

export type ScopeSelectKnowledgeBase = { id: string; name: string }

/**
 * Which knowledge bases the similar-notes search covers.
 *
 * "All" is a rule, not a full selection: it is a chip of its own, mutually
 * exclusive with the individual ones, so a base added later joins the scope
 * instead of being silently left out of a list the user thought was complete.
 * Selecting every base one by one is therefore *not* the same state as "all",
 * and deselecting the last base falls back to it — the panel never searches
 * nothing.
 *
 * Chips toggle on left click; there is no second mouse button in the
 * interaction, which keeps it identical on mobile.
 */
const ScopeSelect: React.FC<{
  knowledgeBases: ScopeSelectKnowledgeBase[]
  /** `undefined` means every base. Never an empty array. */
  selectedIds?: string[]
  onChange: (selectedIds: string[] | undefined) => void
  onManageKnowledgeBases: () => void
}> = ({ knowledgeBases, selectedIds, onChange, onManageKnowledgeBases }) => {
  const { t } = useLanguage()
  const [isOpen, setIsOpen] = useState(false)
  // The open popover edits a draft, not the setting. Committing per chip
  // would re-run a cross-base vector search on every click while the user is
  // still assembling the selection; the scope row and the results move once,
  // together, when the popover closes.
  const [draftIds, setDraftIds] = useState<string[] | undefined>(undefined)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const allLabel = t(
    'sparkle.similarNotes.allKnowledgeBases',
    'All knowledge bases',
  )
  // Ids can outlive their base, so resolve against what actually exists —
  // both for the summary and for deciding whether "all" is the active chip.
  const resolve = (ids: string[] | undefined) =>
    knowledgeBases
      .filter((kb) => ids?.includes(kb.id) ?? false)
      .map((kb) => kb.id)

  const committedIds = resolve(selectedIds)
  // Chips show the draft while open; the trigger always shows the committed
  // scope, so the row never claims a range the results were not computed for.
  const editingIds = isOpen ? resolve(draftIds) : committedIds
  const isAllEditing = editingIds.length === 0

  const summary = (() => {
    if (committedIds.length === 0) return allLabel
    // One base is the common case — a bare count would hide the very thing
    // the user just chose, and a single name usually fits the row.
    if (committedIds.length === 1) {
      return (
        knowledgeBases.find((kb) => kb.id === committedIds[0])?.name ?? allLabel
      )
    }
    return t(
      'sparkle.similarNotes.someKnowledgeBases',
      '{count} knowledge bases',
    ).replace('{count}', String(committedIds.length))
  })()

  const toggle = (id: string) => {
    const next = editingIds.includes(id)
      ? editingIds.filter((value) => value !== id)
      : [...editingIds, id]
    setDraftIds(next.length === 0 ? undefined : next)
  }

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open)
    if (open) {
      setDraftIds(selectedIds)
      return
    }
    // Commit only a real change, so opening and closing the popover without
    // touching anything writes no settings and re-runs no search.
    const next = resolve(draftIds)
    if (next.join('\n') !== committedIds.join('\n')) {
      onChange(next.length === 0 ? undefined : next)
    }
  }

  return (
    <DropdownMenu.Root open={isOpen} onOpenChange={handleOpenChange}>
      <DropdownMenu.Trigger
        ref={triggerRef}
        type="button"
        className="yolo-sparkle-scope-trigger"
      >
        <span className="yolo-sparkle-scope-trigger-label">{summary}</span>
        {isOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </DropdownMenu.Trigger>
      <YoloDropdownContent
        anchorRef={triggerRef}
        variant="default"
        // Narrow on purpose: the sidebar section is only ~350px, so a wider
        // surface stops reading as a popover over the row and starts reading
        // as the panel itself. 240 still fits two chips per line at the name
        // lengths knowledge bases actually have.
        minWidth={180}
        maxWidth={240}
        maxHeight={280}
        className="yolo-popover-sparkle-scope"
        side="bottom"
        align="center"
        sideOffset={6}
        collisionPadding={10}
      >
        <div className="yolo-sparkle-scope-chips">
          <button
            type="button"
            className="yolo-sparkle-scope-chip"
            data-selected={isAllEditing}
            aria-pressed={isAllEditing}
            onClick={() => setDraftIds(undefined)}
          >
            {allLabel}
          </button>
          {knowledgeBases.map((kb) => (
            <button
              key={kb.id}
              type="button"
              className="yolo-sparkle-scope-chip"
              data-selected={editingIds.includes(kb.id)}
              aria-pressed={editingIds.includes(kb.id)}
              onClick={() => toggle(kb.id)}
            >
              {kb.name}
            </button>
          ))}
        </div>
        {/* 管理知识库是低频维护动作，归属在范围这里而不是常驻在范围行上：
            紧挨着范围显示的第二个入口会被读成「改范围」，而改范围正是上面
            这排 chips 做的事。走 handleOpenChange 关闭，顺带提交草稿——用户
            可能刚调完范围才想起要去加内容。 */}
        <button
          type="button"
          className="yolo-sparkle-scope-manage"
          onClick={() => {
            handleOpenChange(false)
            onManageKnowledgeBases()
          }}
        >
          {t(
            'sparkle.similarNotes.manageKnowledgeBases',
            'Manage knowledge bases…',
          )}
        </button>
      </YoloDropdownContent>
    </DropdownMenu.Root>
  )
}

export default ScopeSelect
