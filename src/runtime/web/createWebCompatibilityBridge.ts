import {
  App,
  htmlToMarkdown,
  Keymap,
  MarkdownRenderer,
  MarkdownView,
  normalizePath,
  Platform,
  TFile,
  TFolder,
} from './obsidianCompat'

import type { YoloRuntimeCompatibilityBridge } from '../yoloRuntime.types'

export function createWebCompatibilityBridge({
  app,
  plugin,
}: {
  app: App
  plugin: unknown
}): YoloRuntimeCompatibilityBridge {
  return {
    app,
    plugin,
    TFile,
    TFolder,
    MarkdownView,
    MarkdownRenderer,
    platform: Platform,
    keymap: Keymap,
    utils: {
      htmlToMarkdown,
      normalizePath,
    },
  }
}
