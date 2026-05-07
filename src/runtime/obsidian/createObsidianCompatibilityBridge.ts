import {
  htmlToMarkdown,
  Keymap,
  MarkdownRenderer,
  MarkdownView,
  normalizePath,
  Platform,
  TFile,
  TFolder,
} from 'obsidian'

import type SmartComposerPlugin from '../../main'
import type { YoloRuntimeCompatibilityBridge } from '../yoloRuntime.types'

export function createObsidianCompatibilityBridge(
  plugin: SmartComposerPlugin,
): YoloRuntimeCompatibilityBridge {
  return {
    app: plugin.app,
    plugin,
    TFile,
    TFolder,
    MarkdownView,
    MarkdownRenderer,
    platform: {
      isMacOS: !!(Platform as any).isMacOS,
      isDesktopApp: !!(Platform as any).isDesktopApp,
      isPhone: !!(Platform as any).isPhone,
      isIosApp: !!(Platform as any).isIosApp,
    },
    keymap: {
      isModEvent: (e: any) => Keymap.isModEvent(e),
    },
    utils: {
      htmlToMarkdown: (html) => htmlToMarkdown(html),
      normalizePath: (path) => normalizePath(path),
    },
  }
}
