import { TFile } from 'obsidian'
import { useEffect, useRef, useState } from 'react'

import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  type SimilarNote,
  findSimilarNotes,
  isEmbeddingModelConfigured,
} from '../../../core/rag/similarNotes'

export type SimilarNotesState =
  | { status: 'no-file' }
  | { status: 'no-embedding-model' }
  | { status: 'loading' }
  | { status: 'ready'; notes: SimilarNote[] }
  | { status: 'source-not-indexed'; indexableKbIds: string[] }
  | { status: 'error'; message: string }

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
}: {
  file: TFile | null
  visible: boolean
  /** Bumped by the panel's manual refresh; recomputes without other deps changing. */
  refreshToken: number
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
  const scopeKbId = settings.continuationOptions.similarNotesKnowledgeBaseId
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
    setState({ status: 'loading' })
    void (async () => {
      try {
        const outcome = await findSimilarNotes({
          ragAccess: plugin.getRagAccess(),
          settings: currentSettings,
          path,
          scopeKbId,
        })
        if (generationRef.current !== generation) return
        setState(
          outcome.kind === 'ready'
            ? { status: 'ready', notes: outcome.notes }
            : {
                status: 'source-not-indexed',
                indexableKbIds: outcome.indexableKbIds,
              },
        )
      } catch (error) {
        if (generationRef.current !== generation) return
        console.error('[YOLO] Similar notes lookup failed.', error)
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  }, [plugin, path, scopeKbId, embeddingModelId, visible, refreshToken])

  return state
}
