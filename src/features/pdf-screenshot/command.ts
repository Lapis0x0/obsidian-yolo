/**
 * command.ts
 *
 * Registers the `capture-pdf-region` command and orchestrates the
 * select → capture → inject pipeline.
 *
 * The command:
 *   1. Finds the active PDF leaf (or the most-recently active PDF leaf).
 *   2. Mounts a RegionSelector overlay on that leaf's view container.
 *   3. On selection complete: captures the region from the PDF.js canvas,
 *      builds a MentionableImage, and injects it into the active chat panel
 *      (opening one if none exists).
 *   4. On cancel: silently removes the overlay.
 */

import { Notice } from 'obsidian'

import type SmartComposerPlugin from '../../main'
import type { MentionableImage } from '../../types/mentionable'

import { captureCanvasRegion } from './captureCanvasRegion'
import { RegionSelector } from './RegionSelector'

/** Keeps track of an active region selector so double-triggering cancels it. */
let activeSelector: RegionSelector | null = null

export function registerCapturePdfRegionCommand(
  plugin: SmartComposerPlugin,
): void {
  plugin.addCommand({
    id: 'capture-pdf-region',
    name: plugin.t('commands.capturePdfRegion'),
    callback: () => {
      void runCapturePdfRegion(plugin)
    },
  })
}

async function runCapturePdfRegion(plugin: SmartComposerPlugin): Promise<void> {
  // If a selector is already active, cancel it (toggle behavior)
  if (activeSelector) {
    activeSelector.unmount()
    activeSelector = null
    return
  }

  // Find the active PDF leaf
  const pdfLeaf = findActivePdfLeaf(plugin)
  if (!pdfLeaf) {
    new Notice(plugin.t('notices.capturePdfNoLeaf'))
    return
  }

  // The PDF view's container element — we'll overlay the selector on this
  const viewContainerEl = (pdfLeaf.view as { containerEl?: HTMLElement })
    ?.containerEl
  if (!viewContainerEl) {
    new Notice(plugin.t('notices.capturePdfNoLeaf'))
    return
  }

  const hintText = plugin.t('pdf.regionSelectorHint')

  const selector = new RegionSelector(viewContainerEl, {
    hintText,
    onComplete: (region) => {
      activeSelector = null

      const result = captureCanvasRegion(region.canvas, {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
      })

      if (!result) {
        new Notice(plugin.t('notices.capturePdfFailed'))
        return
      }

      // Build a filename like: pdf-region-filename-p3-1714839600000.png
      const pdfFile = (pdfLeaf.view as { file?: { basename?: string } })?.file
      const pdfName = pdfFile?.basename ?? 'pdf'
      const fileName = `pdf-region-${pdfName}-p${region.pageNumber}-${Date.now()}.png`

      // MentionableImage.data is consumed directly as image_url.url by the
      // request builder, so it must be a full data URL, not raw base64.
      const mentionableImage: MentionableImage = {
        type: 'image',
        name: fileName,
        mimeType: 'image/png',
        data: `data:image/png;base64,${result.base64}`,
      }

      void injectImageToActiveChat(plugin, mentionableImage)
    },
    onCancel: () => {
      activeSelector = null
    },
  })

  activeSelector = selector
  selector.mount()
}

/**
 * Find the most recently active PDF leaf.
 * Prefers the currently active leaf if it is a PDF view; otherwise falls back
 * to the most recently active PDF leaf tracked by Obsidian's workspace.
 */
function findActivePdfLeaf(plugin: SmartComposerPlugin) {
  const workspace = plugin.app.workspace

  // Check if the active leaf is a PDF view
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Obsidian private API
  const activeLeavesOfType = workspace.getLeavesOfType('pdf')
  if (activeLeavesOfType.length === 0) {
    return null
  }

  // Prefer the most recently active one (Obsidian keeps the active leaf on top)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Obsidian private API
  const activeLeaf = (workspace as any).activeLeaf
  if (activeLeaf && activeLeaf.view?.getViewType?.() === 'pdf') {
    return activeLeaf
  }

  // Fall back to first PDF leaf
  return activeLeavesOfType[0] ?? null
}

/**
 * Inject a MentionableImage into the active / most recent chat panel.
 * If no chat panel is open, open a new sidebar chat and then inject.
 */
async function injectImageToActiveChat(
  plugin: SmartComposerPlugin,
  image: MentionableImage,
): Promise<void> {
  try {
    await plugin.addImageToActiveChat(image)
  } catch (error) {
    console.error('[YOLO] Failed to inject PDF screenshot into chat:', error)
    new Notice(plugin.t('notices.capturePdfInjectFailed'))
  }
}

/**
 * Clean up any lingering selector (called from feature unmount / plugin unload).
 */
export function cleanupCapturePdfRegionCommand(): void {
  if (activeSelector) {
    activeSelector.unmount()
    activeSelector = null
  }
}
