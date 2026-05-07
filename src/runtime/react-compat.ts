/**
 * Phase 1 compatibility surface for shared React modules.
 * Keep React-side diffs limited to import rewiring until the runtime boundary
 * is cleaned up in a later pass.
 */
export type { App } from 'obsidian'
export {
  ButtonComponent,
  Component,
  DropdownComponent,
  Editor,
  getLanguage,
  htmlToMarkdown,
  ItemView,
  Keymap,
  MarkdownRenderer,
  MarkdownView,
  Modal,
  Menu,
  normalizePath,
  Notice,
  Platform,
  PluginSettingTab,
  requestUrl,
  Setting,
  TFile,
  TFolder,
  TextAreaComponent,
  TextComponent,
  ToggleComponent,
  Vault,
  WorkspaceLeaf,
} from 'obsidian'

export { useApp } from '../contexts/app-context'
export { usePlugin } from '../contexts/plugin-context'
