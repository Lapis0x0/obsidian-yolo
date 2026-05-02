/**
 * pdf-screenshot/index.ts
 *
 * Feature entry point. Called from main.ts on plugin load.
 * Guards against mobile (feature is desktop-only).
 */

import { Platform } from 'obsidian'

import type SmartComposerPlugin from '../../main'

import {
  cleanupCapturePdfRegionCommand,
  registerCapturePdfRegionCommand,
} from './command'
import { PdfToolbarButtonManager } from './toolbarButton'

export function enablePdfScreenshotFeature(plugin: SmartComposerPlugin): void {
  if (Platform.isMobile) {
    // PDF UI is completely different on mobile; skip silently
    return
  }

  // Register the primary command entry point
  registerCapturePdfRegionCommand(plugin)

  // Inject the toolbar button as a secondary convenience trigger
  const toolbarManager = new PdfToolbarButtonManager(plugin, () => {
    // Trigger the same command programmatically
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Obsidian internal command API
    ;(plugin.app as any).commands?.executeCommandById(
      `${plugin.manifest.id}:capture-pdf-region`,
    )
  })
  toolbarManager.enable()

  // Cleanup on plugin unload
  plugin.register(() => {
    cleanupCapturePdfRegionCommand()
  })
}
