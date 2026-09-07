/**
 * embeddedQuickAsk.ts
 *
 * Quick Ask on an editor that is not a Markdown view: a card on a board, say.
 *
 * There is no `MarkdownView`, no `TFile`, and no leaf to hang state off — but
 * the two things Quick Ask actually writes through are here. Continuation
 * needs Obsidian's `Editor`, selection rewrite needs the CodeMirror view, and
 * an embedded editor carries both. So the panel opens with full edit
 * capability rather than a read-only variant.
 *
 * Deliberately not routed through `QuickAskController`: that controller owns
 * the *Markdown view* route — one panel at a time, mounted through a
 * CodeMirror state effect, with selection highlights and PDF instances to
 * prune. An embedded editor needs none of it and would have to be threaded
 * through every one of those paths as a special case.
 */

import { StateEffect } from '@codemirror/state'

import { QuickAskOverlay } from '../../../components/panels/quick-ask'
import type {
  ObsidianMarkdownEditorQuickAskSession,
  ObsidianMarkdownEditorQuickAskTarget,
} from '../../../core/modules/obsidianMarkdownEditor'
import type YoloPlugin from '../../../main'

import { createCmAnchor } from './quickAsk.anchor'
import { buildQuickAskContextText } from './quickAsk.context'
import { createQuickAskTriggerExtension } from './quickAsk.trigger'

export type EmbeddedQuickAskOptions = {
  /**
   * Describes what the editor is embedded in — read when a request is built,
   * so a surface that keeps changing is described as it is at that moment.
   */
  getContext?: () => string | Promise<string>
  /** Fires when the editor moves without scrolling; see `QuickAskAnchor`. */
  subscribeAnchorMove?: (onMove: () => void) => () => void
}

export type AttachEmbeddedQuickAsk = (
  options: EmbeddedQuickAskOptions,
  target: ObsidianMarkdownEditorQuickAskTarget,
) => ObsidianMarkdownEditorQuickAskSession

export function createEmbeddedQuickAskAttacher(
  plugin: YoloPlugin,
): AttachEmbeddedQuickAsk {
  return (options, target) => {
    const { view, editor, sourcePath } = target
    let overlay: QuickAskOverlay | null = null
    let disposed = false

    const closePanel = () => {
      const current = overlay
      if (!current) return
      overlay = null
      current.destroy()
      // Focus goes back where the user left it. Whether it lands is what
      // decides if the owner hears the blur it was not told about.
      if (!disposed && view.dom.isConnected) view.focus()
      target.onPanelOpenChange(false)
    }

    const mount = () => {
      const pos = view.state.selection.main.head
      const mounted = new QuickAskOverlay({
        plugin,
        anchor: createCmAnchor(view, pos, null, {
          ...(options.subscribeAnchorMove
            ? { subscribe: options.subscribeAnchorMove }
            : {}),
        }),
        capabilities: { edit: true, editor, view },
        contextText: buildQuickAskContextText(view, pos, plugin.settings),
        // The editor's content lives inside `sourcePath` rather than being
        // that file, so the path is all there is to name it by.
        fileTitle: sourcePath.split('/').pop() ?? sourcePath,
        sourceFilePath: sourcePath,
        ...(options.getContext
          ? { getSurfaceContext: options.getContext }
          : {}),
        onClose: closePanel,
      })
      overlay = mounted
      target.onPanelOpenChange(true)
      mounted.mount(pos)
    }

    const open = () => {
      if (overlay) {
        QuickAskOverlay.focusCurrentInput()
        return
      }
      void plugin
        .warmupAgentService()
        .then(() => {
          if (disposed || overlay || !view.dom.isConnected) return
          mount()
        })
        .catch((error: unknown) => {
          console.error('[YOLO] Failed to open Quick Ask:', error)
        })
    }

    // Appended rather than passed at construction: the editor component is
    // Obsidian's, built before the host gets to see it.
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        createQuickAskTriggerExtension({
          getSettings: () => plugin.settings,
          canTrigger: () => !disposed,
          show: open,
        }),
      ),
    })

    return {
      destroy: () => {
        disposed = true
        const current = overlay
        overlay = null
        current?.destroy()
      },
    }
  }
}
