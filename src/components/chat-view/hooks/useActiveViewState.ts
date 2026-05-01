import { EditorView } from '@codemirror/view'
import { MarkdownView, TFile } from 'obsidian'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useApp } from '../../../contexts/app-context'
import type { CurrentFileViewState } from '../../../types/mentionable'

export type ActiveViewState = {
  file: TFile | null
  viewState: CurrentFileViewState | undefined
}

function shallowEqualViewState(
  a: CurrentFileViewState | undefined,
  b: CurrentFileViewState | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.kind !== b.kind) return false
  if (a.kind === 'markdown-edit' && b.kind === 'markdown-edit') {
    return (
      a.visibleStartLine === b.visibleStartLine &&
      a.visibleEndLine === b.visibleEndLine &&
      a.cursorLine === b.cursorLine &&
      a.totalLines === b.totalLines
    )
  }
  if (a.kind === 'pdf' && b.kind === 'pdf') {
    return a.currentPage === b.currentPage && a.totalPages === b.totalPages
  }
  // kind === 'other'
  if (a.kind === 'other' && b.kind === 'other') {
    return a.totalLines === b.totalLines
  }
  return false
}

/**
 * Collects the current active view state: file + viewport-aware position info.
 * - MarkdownView edit mode: visible line range + cursor line
 * - PDFView: current page + total pages
 * - Other views: kind='other' with optional totalLines
 */
export function useActiveViewState(): ActiveViewState {
  const app = useApp()

  const [state, setState] = useState<ActiveViewState>(() => ({
    file: app.workspace.getActiveFile(),
    viewState: undefined,
  }))

  // Holds cleanup for CM6 / PDF listeners attached to the current view
  const viewCleanupRef = useRef<(() => void) | null>(null)
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const applyViewState = useCallback(
    (newViewState: CurrentFileViewState | undefined) => {
      setState((prev) => {
        if (shallowEqualViewState(prev.viewState, newViewState)) return prev
        return { ...prev, viewState: newViewState }
      })
    },
    [],
  )

  const pendingViewStateRef = useRef<CurrentFileViewState | undefined>(
    undefined,
  )
  const hasPendingRef = useRef(false)

  // Trailing throttle: keep applying the latest value, at most every 200ms.
  const throttledApplyViewState = useCallback(
    (newViewState: CurrentFileViewState | undefined) => {
      pendingViewStateRef.current = newViewState
      hasPendingRef.current = true
      if (throttleTimerRef.current !== null) return
      throttleTimerRef.current = setTimeout(() => {
        throttleTimerRef.current = null
        if (hasPendingRef.current) {
          hasPendingRef.current = false
          applyViewState(pendingViewStateRef.current)
        }
      }, 200)
    },
    [applyViewState],
  )

  const attachToCurrentView = useCallback(() => {
    // Tear down previous listeners
    viewCleanupRef.current?.()
    viewCleanupRef.current = null
    if (throttleTimerRef.current !== null) {
      clearTimeout(throttleTimerRef.current)
      throttleTimerRef.current = null
    }

    const newFile = app.workspace.getActiveFile()
    setState((prev) => {
      if (prev.file?.path === newFile?.path) return prev
      return { file: newFile, viewState: undefined }
    })

    // Find the MarkdownView for the current file by leaf, not by active focus.
    // When the user is typing in the chat panel, `getActiveViewOfType` returns
    // null (active view is the ChatView), which would silently drop us into
    // `{ kind: 'other' }` and lose viewport / cursor info even though the
    // markdown file is still open in another leaf.
    const activeView = newFile
      ? (app.workspace
          .getLeavesOfType('markdown')
          .map((leaf) => (leaf.view instanceof MarkdownView ? leaf.view : null))
          .find(
            (view): view is MarkdownView => view?.file?.path === newFile.path,
          ) ?? null)
      : null
    if (activeView) {
      const mode = activeView.getMode()

      if (mode === 'source') {
        // CM6 edit mode
        const editorAny = activeView.editor as { cm?: unknown } | undefined
        const cmView = editorAny?.cm instanceof EditorView ? editorAny.cm : null

        if (cmView) {
          const readViewState = (): CurrentFileViewState => {
            const state = cmView.state
            const doc = state.doc
            const totalLines = doc.lines

            // Use visibleRanges (not viewport) for true visible content
            const visibleRanges = cmView.visibleRanges
            if (visibleRanges.length === 0) {
              return { kind: 'other', totalLines }
            }

            const firstRange = visibleRanges[0]
            const lastRange = visibleRanges[visibleRanges.length - 1]
            if (!firstRange || !lastRange) {
              return { kind: 'other', totalLines }
            }

            const visibleStartLine = doc.lineAt(firstRange.from).number
            const visibleEndLine = doc.lineAt(lastRange.to).number

            const selection = state.selection.main
            const cursorLine = doc.lineAt(selection.head).number

            return {
              kind: 'markdown-edit',
              visibleStartLine,
              visibleEndLine,
              cursorLine,
              totalLines,
            }
          }

          // Initial read
          applyViewState(readViewState())

          // We can't safely inject a CM6 updateListener from outside the
          // EditorState — Compartment.reconfigure on a never-registered
          // compartment is a no-op, and registerEditorExtension is plugin-scoped.
          // Instead, listen to DOM events on the editor surface. This covers
          // the user-perceivable triggers: scroll (viewport), cursor moves
          // (mouse / keyboard), and edits.
          const onChange = () => {
            throttledApplyViewState(readViewState())
          }
          const scrollDOM = cmView.scrollDOM
          const contentDOM = cmView.contentDOM
          scrollDOM.addEventListener('scroll', onChange, { passive: true })
          contentDOM.addEventListener('keyup', onChange)
          contentDOM.addEventListener('mouseup', onChange)
          contentDOM.addEventListener('input', onChange)
          contentDOM.addEventListener('focus', onChange)

          viewCleanupRef.current = () => {
            scrollDOM.removeEventListener('scroll', onChange)
            contentDOM.removeEventListener('keyup', onChange)
            contentDOM.removeEventListener('mouseup', onChange)
            contentDOM.removeEventListener('input', onChange)
            contentDOM.removeEventListener('focus', onChange)
          }
          return
        }
      }

      // Reading mode or non-CM6 markdown
      const file = activeView.file
      const totalLines = file
        ? (() => {
            // Best-effort: read from cached content if available
            try {
              const content = (
                activeView.editor as { getValue?: () => string } | undefined
              )?.getValue?.()
              if (content !== undefined) {
                return content.split('\n').length
              }
            } catch {
              // ignore
            }
            return undefined
          })()
        : undefined
      applyViewState({ kind: 'other', totalLines })
      viewCleanupRef.current = null
      return
    }

    // Check for PDF view — use getLeavesOfType to avoid deprecated activeLeaf
    const pdfLeaves = app.workspace.getLeavesOfType('pdf')
    const pdfLeafForCurrentFile = pdfLeaves.find((leaf) => {
      try {
        const leafFile = (leaf.view as { file?: TFile } | undefined)?.file
        return leafFile?.path === newFile?.path
      } catch {
        return false
      }
    })
    if (pdfLeafForCurrentFile) {
      const view = pdfLeafForCurrentFile.view
      if (view.getViewType() === 'pdf') {
        try {
          const pdfViewer = (view as any)?.viewer?.child?.pdfViewer
          if (pdfViewer) {
            // Obsidian's PDF viewer (PDF.js wrapped) uses `pv.page` for the
            // current page number, not the standard `currentPageNumber` getter.
            // The 'pagechanging' event payload carries `pageNumber`.
            const buildPdfState = (
              currentPage: unknown,
              totalPages: unknown,
            ): CurrentFileViewState => {
              if (
                typeof currentPage === 'number' &&
                typeof totalPages === 'number' &&
                Number.isFinite(currentPage) &&
                Number.isFinite(totalPages) &&
                totalPages > 0 &&
                currentPage >= 1 &&
                currentPage <= totalPages
              ) {
                return { kind: 'pdf', currentPage, totalPages }
              }
              return { kind: 'other' }
            }

            const readPdfState = (): CurrentFileViewState => {
              try {
                const v = (view as any).viewer?.child?.pdfViewer
                return buildPdfState(v?.page, v?.pagesCount)
              } catch {
                return { kind: 'other' }
              }
            }

            applyViewState(readPdfState())

            const handler = (evt: unknown) => {
              const payload = evt as { pageNumber?: unknown } | undefined
              try {
                const v = (view as any).viewer?.child?.pdfViewer
                applyViewState(
                  buildPdfState(payload?.pageNumber ?? v?.page, v?.pagesCount),
                )
              } catch {
                applyViewState({ kind: 'other' })
              }
            }
            try {
              pdfViewer.eventBus.on('pagechanging', handler)
              viewCleanupRef.current = () => {
                try {
                  pdfViewer.eventBus.off('pagechanging', handler)
                } catch {
                  // ignore
                }
              }
            } catch {
              applyViewState({ kind: 'other' })
              viewCleanupRef.current = null
            }
            return
          }
        } catch {
          // PDF internal API inaccessible
        }
        applyViewState({ kind: 'other' })
        viewCleanupRef.current = null
        return
      }
    }

    // Other view types
    applyViewState({ kind: 'other' })
    viewCleanupRef.current = null
  }, [app.workspace, applyViewState, throttledApplyViewState])

  useEffect(() => {
    attachToCurrentView()

    const handleLeafChange = () => {
      attachToCurrentView()
    }

    app.workspace.on('active-leaf-change', handleLeafChange)
    app.workspace.on('file-open', handleLeafChange)
    // 'layout-change' fires when the user toggles source/preview within the
    // same leaf — without it we'd keep stale CM listeners attached and
    // misreport markdown-edit while the user is in reading mode.
    app.workspace.on('layout-change', handleLeafChange)

    return () => {
      viewCleanupRef.current?.()
      viewCleanupRef.current = null
      if (throttleTimerRef.current !== null) {
        clearTimeout(throttleTimerRef.current)
        throttleTimerRef.current = null
      }
      app.workspace.off('active-leaf-change', handleLeafChange)
      app.workspace.off('file-open', handleLeafChange)
      app.workspace.off('layout-change', handleLeafChange)
    }
  }, [app.workspace, attachToCurrentView])

  return state
}
