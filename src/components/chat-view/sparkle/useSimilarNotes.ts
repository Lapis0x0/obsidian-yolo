import { TFile } from 'obsidian'
import { type RefObject, useEffect, useRef, useState } from 'react'

import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  type SimilarNote,
  findSimilarNotes,
  isEmbeddingModelConfigured,
} from '../../../core/rag/similarNotes'
import { getNodeWindow } from '../../../utils/dom/window-context'

export type SimilarNotesState =
  | { status: 'no-file' }
  | { status: 'no-embedding-model' }
  | { status: 'loading' }
  /** `path` is the note these results describe — not necessarily the active
   *  one, during the brief window where a newer query is still running. */
  | { status: 'ready'; path: string; notes: SimilarNote[] }
  | { status: 'source-not-indexed'; indexableKbIds: string[] }
  | { status: 'error'; message: string }

/**
 * How long a query may run before the panel admits to loading. Measured on a
 * warm index, switching notes resolves in ~10-35ms; publishing a skeleton for
 * that long renders a loading state nobody can read as one, and the panel
 * just flickers. Under this threshold the previous results stay on screen and
 * the swap happens once, when the new ones land.
 */
const LOADING_STATE_DELAY_MS = 160

/**
 * Similar notes for the note the user is currently in. Recomputes when the
 * active file or the searched scope changes, never while typing — the source
 * is the note's stored chunk vectors, and an index that lags the last
 * paragraph is the normal state, not something to chase.
 *
 * `visible` gates the whole thing: an off-screen panel (collapsed sidebar,
 * hidden window) computes nothing, and picks up the current file the moment
 * it comes back.
 */
export function useSimilarNotes({
  file,
  visible,
  refreshToken,
  hostRef,
}: {
  file: TFile | null
  visible: boolean
  /** Bumped by the panel's manual refresh; recomputes without other deps changing. */
  refreshToken: number
  /** A node inside the panel, so the delay timer belongs to the window the
   *  panel actually lives in rather than the main window's globals. */
  hostRef: RefObject<HTMLElement | null>
}): SimilarNotesState {
  const plugin = usePlugin()
  const { settings } = useSettings()
  // Starts as loading, not 'no-file': the panel's first frame runs before
  // the visibility observer reports in, and a flash of "no note is open"
  // there would be a lie.
  const [state, setState] = useState<SimilarNotesState>({ status: 'loading' })
  // Every run carries a generation; a run whose generation is stale by the
  // time it resolves (the user switched notes mid-query) drops its result
  // instead of overwriting the newer one.
  const generationRef = useRef(0)
  // Read inside the effect only, so an unrelated settings save doesn't
  // re-run the query — the fields that do affect it are dependencies.
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const path = file?.path ?? null
  const scopeKbIds = settings.continuationOptions.similarNotesKnowledgeBaseIds
  // The effect depends on which bases are searched, not on the array's
  // identity — settings rebuilds the array on every save, and depending on
  // the reference would re-query on unrelated setting changes.
  const scopeKey = scopeKbIds?.join('\n') ?? ''
  const embeddingModelId = settings.embeddingModelId

  useEffect(() => {
    if (!visible) return
    if (path === null) {
      setState({ status: 'no-file' })
      return
    }
    const currentSettings = settingsRef.current
    if (!isEmbeddingModelConfigured(currentSettings)) {
      setState({ status: 'no-embedding-model' })
      return
    }

    const generation = ++generationRef.current
    // Deliberately not published yet: a query that finishes inside the
    // threshold never shows a skeleton at all.
    const host = getNodeWindow(hostRef.current)
    const loadingTimer = host.setTimeout(() => {
      if (generationRef.current !== generation) return
      setState({ status: 'loading' })
    }, LOADING_STATE_DELAY_MS)
    const settle = (next: SimilarNotesState) => {
      host.clearTimeout(loadingTimer)
      if (generationRef.current !== generation) return
      setState(next)
    }
    void (async () => {
      try {
        const outcome = await findSimilarNotes({
          ragAccess: plugin.getRagAccess(),
          settings: currentSettings,
          path,
          scopeKbIds:
            currentSettings.continuationOptions.similarNotesKnowledgeBaseIds,
        })
        settle(
          outcome.kind === 'ready'
            ? { status: 'ready', path, notes: outcome.notes }
            : {
                status: 'source-not-indexed',
                indexableKbIds: outcome.indexableKbIds,
              },
        )
      } catch (error) {
        console.error('[YOLO] Similar notes lookup failed.', error)
        settle({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })()
    return () => host.clearTimeout(loadingTimer)
  }, [plugin, path, scopeKey, embeddingModelId, visible, refreshToken, hostRef])

  return state
}
