import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react'

import type { Mentionable } from '../../../types/mentionable'

import { pdfSelectionHighlightController } from './pdfSelectionHighlightController'
import { selectionHighlightController } from './selectionHighlightController'

type UseChatHighlightSessionArgs = {
  conversationId: string
  containerRef: RefObject<HTMLElement | null>
  /** Mentionables currently in the input box. */
  inputMentionables: Mentionable[]
  /**
   * Mentionables on the historical user message being edited in place, or
   * `null` when the input box itself has focus.
   */
  focusedHistoricalMentionables: Mentionable[] | null
}

/**
 * Editor leaf surfaces that count as "user interacted with a real editor" and
 * therefore end the current sticky cycle.  Includes both the markdown CM
 * editor and Obsidian's built-in PDF viewer.
 */
const EDITOR_LEAF_SELECTOR =
  '.workspace-leaf-content[data-type="markdown"], .workspace-leaf-content[data-type="pdf"]'

/**
 * Collect the runtime highlightIds carried by selection-style block
 * mentionables.  Highlights only get a runtime id when they were created in
 * the current process via `addHighlight`; mentions deserialized from disk
 * never carry one, so this is safe to call on chat history without surfacing
 * ghost ids across restarts.
 */
function collectSelectionHighlightIds(
  mentionables: Mentionable[],
): Set<string> {
  const ids = new Set<string>()
  for (const m of mentionables) {
    if (m.type !== 'block') continue
    if (
      m.source !== 'selection' &&
      m.source !== 'selection-sync' &&
      m.source !== 'selection-pinned'
    ) {
      continue
    }
    if (m.highlightId) ids.add(m.highlightId)
  }
  return ids
}

function dispatchReconcile(activeIds: Set<string>): void {
  selectionHighlightController.reconcileActiveIds(activeIds)
  pdfSelectionHighlightController.reconcileActiveIds(activeIds)
}

export type UseChatHighlightSessionResult = {
  /**
   * Promote the selection highlight ids from the user message being submitted
   * into the sticky set.  Call synchronously right before clearing the input
   * on send so sent mentions keep their editor highlight until the next editor
   * interaction, without making unsent mentions sticky.
   */
  commitSentSelectionHighlights: (mentionables: Mentionable[]) => void
  /** Drop committed sticky ids when their mention is deleted. */
  releaseHighlightIds: (ids: Iterable<string>) => void
}

/**
 * Owns the "sticky" lifecycle for chat-owned selection highlights.
 *
 * Background: each chat highlight is registered with the singleton highlight
 * controller via `addHighlight(view, id, ..., owner: 'chat')` when the user
 * creates a selection-style mentionable.  The controller's
 * `reconcileActiveIds(ids)` deletes every chat-owned entry whose id is NOT in
 * `ids`, so whoever drives reconcile decides the visible set.
 *
 * This hook unifies the lifecycle:
 *
 * - `liveIds` are recomputed from the input box plus the historical user
 *   message currently being edited in place.  While a mention (sync or pinned)
 *   still sits in those surfaces, its highlight id is kept alive via
 *   `liveIds` alone — deleting the mention reconciles immediately.
 *
 * - Selection ids enter the session-scoped sticky set only when the chat calls
 *   `commitSentSelectionHighlights` with the message being submitted.  That is
 *   what lets a highlight survive after the mention leaves the input box
 *   without treating an unsent mention as already sticky (which would block
 *   deletion).
 *
 * - First `pointerdown` / `focusin` on any markdown / pdf workspace leaf
 *   outside the chat view container clears sticky ids and reconciles
 *   immediately.  This drops every previously committed highlight, while
 *   keeping any live mention that still sits in the input box.  The next sent
 *   mention begins a fresh sticky cycle — the lifecycle is loop-shaped, not
 *   one-shot.
 *
 * - `releaseHighlightIds` removes explicit ids from sticky when a mention is
 *   deleted from history (e.g. delete-from-all), so committed highlights do
 *   not outlive their mention.
 *
 * - When `conversationId` changes (load another conversation, new chat, …)
 *   the sticky set is wiped and reconcile is dispatched with an empty set,
 *   so all chat-owned highlights disappear immediately rather than waiting
 *   for the next render of the new conversation.
 *
 * - On unmount the sticky set is wiped the same way.
 */
export function useChatHighlightSession({
  conversationId,
  containerRef,
  inputMentionables,
  focusedHistoricalMentionables,
}: UseChatHighlightSessionArgs): UseChatHighlightSessionResult {
  // Compute live ids.  Memoised on a content key so that downstream effects
  // only re-run when the actual id set changes — not on every parent render.
  const liveIds = useMemo(() => {
    const ids = collectSelectionHighlightIds(inputMentionables)
    if (focusedHistoricalMentionables) {
      for (const id of collectSelectionHighlightIds(
        focusedHistoricalMentionables,
      )) {
        ids.add(id)
      }
    }
    return ids
  }, [inputMentionables, focusedHistoricalMentionables])

  const liveIdsKey = useMemo(
    () => Array.from(liveIds).sort().join('|'),
    [liveIds],
  )

  const stickyIdsRef = useRef<Set<string>>(new Set())
  const liveIdsRef = useRef<Set<string>>(liveIds)
  liveIdsRef.current = liveIds

  const reconcileCurrent = useCallback(() => {
    dispatchReconcile(new Set([...stickyIdsRef.current, ...liveIdsRef.current]))
  }, [])

  const commitSentSelectionHighlights = useCallback(
    (mentionables: Mentionable[]) => {
      for (const id of collectSelectionHighlightIds(mentionables)) {
        stickyIdsRef.current.add(id)
      }
      reconcileCurrent()
    },
    [reconcileCurrent],
  )

  const releaseHighlightIds = useCallback(
    (ids: Iterable<string>) => {
      let changed = false
      for (const id of ids) {
        if (stickyIdsRef.current.delete(id)) {
          changed = true
        }
      }
      if (changed) {
        reconcileCurrent()
      }
    },
    [reconcileCurrent],
  )

  // IMPORTANT: the conversation reset effect must run BEFORE the live merge
  // effect on a render where both fire (mount, conversation switch).  React
  // runs passive effects in declaration order, so this one is declared first;
  // the live merge effect below also depends on `conversationId`, so it
  // re-seeds sticky from the current live ids right after the reset.
  //
  // Without this ordering, opening / switching into a conversation that
  // already has live mentions in the input would briefly install the
  // highlights and then the conversation effect would wipe them.
  useEffect(() => {
    stickyIdsRef.current = new Set()
    dispatchReconcile(new Set())
  }, [conversationId])

  // Reconcile whenever live mentions change.  In-input / in-place-edit ids are
  // driven purely by liveIds; sticky only contributes ids committed on send.
  useEffect(() => {
    reconcileCurrent()
  }, [conversationId, liveIdsKey, reconcileCurrent])

  // First interaction with any real editor (CM or PDF) outside the chat
  // container ends the current sticky cycle.  Listeners stay installed for
  // the lifetime of the chat view: every subsequent batch of mentions enters
  // a new sticky cycle and likewise clears on the next editor interaction.
  useEffect(() => {
    const handle = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const container = containerRef.current
      if (container && container.contains(target)) return
      if (!target.closest(EDITOR_LEAF_SELECTOR)) return
      // Returning to a real editor ends the sent-message sticky cycle.  Live
      // input / in-place-edit mentions still render through liveIds.
      stickyIdsRef.current = new Set()
      reconcileCurrent()
    }
    document.addEventListener('pointerdown', handle, true)
    document.addEventListener('focusin', handle, true)
    return () => {
      document.removeEventListener('pointerdown', handle, true)
      document.removeEventListener('focusin', handle, true)
    }
  }, [containerRef, reconcileCurrent])

  // Unmount: same cleanup as a conversation switch, so closing the chat view
  // never leaves stale highlights behind.
  useEffect(() => {
    return () => {
      stickyIdsRef.current = new Set()
      dispatchReconcile(new Set())
    }
  }, [])

  return { commitSentSelectionHighlights, releaseHighlightIds }
}
