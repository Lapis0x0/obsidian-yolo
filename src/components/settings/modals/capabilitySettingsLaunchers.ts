import { App } from 'obsidian'

import { DEFAULT_BLOCKED_PREFIXES } from '../../../core/agent/bash/command-classifier'
import type { BuiltinCapabilityId } from '../../../core/tools/registry'
import type YoloPlugin from '../../../main'
import type { YoloSettings } from '../../../settings/schema/setting.types'

import { JsSandboxConfigModal } from './JsSandboxConfigModal'
import { SubagentConfigModal } from './SubagentConfigModal'
import { TerminalCommandConfigModal } from './TerminalCommandConfigModal'
import { WebSearchSettingsModal } from './WebSearchSettingsModal'

type TranslateFn = (key: string, fallback?: string) => string

/**
 * Context a capability's settings launcher needs to open its modal. Kept
 * minimal to what `openSubagentSettings` actually used at D3/D4. D6 batch 5/6
 * add the three remaining `hasSettings: true` capabilities
 * (js_sandbox/terminal/web_access) — only `openWebSearchSettings` needs the
 * added `plugin` field (`WebSearchSettingsModal` takes `(app, plugin)`, the
 * one dedicated-settings modal that isn't `(app, { title, value, onChange })`
 * shaped); the other two ignore it, matching this type's original
 * "additive, non-breaking extension" note.
 */
export type CapabilitySettingsLauncherContext = {
  app: App
  settings: YoloSettings
  setSettings: (settings: YoloSettings) => Promise<boolean>
  t: TranslateFn
  plugin?: YoloPlugin
}

export type SettingsLauncher = (ctx: CapabilitySettingsLauncherContext) => void

// Reads/writes `settings.mcp.builtinCapabilityOptions.subagent_delegation` —
// the capability-id key as of the `80_to_81` settings migration (D9,
// docs/plans/2026-08-15-tool-registry/phase2-migration.md D9). Was keyed by
// the old short tool name `delegate_subagent` before that migration landed.
const openSubagentSettings: SettingsLauncher = ({
  app,
  settings,
  setSettings,
  t,
}) => {
  new SubagentConfigModal(app, {
    title: t('settings.subagent.openSettings', 'Configure subagent models'),
    settings,
    value: settings.mcp.builtinCapabilityOptions.subagent_delegation ?? {},
    onChange: (next) =>
      void setSettings({
        ...settings,
        mcp: {
          ...settings.mcp,
          builtinCapabilityOptions: {
            ...settings.mcp.builtinCapabilityOptions,
            subagent_delegation: {
              ...settings.mcp.builtinCapabilityOptions.subagent_delegation,
              ...next,
            },
          },
        },
      }),
  }).open()
}

// Ported verbatim from the `tool.id === JS_SANDBOX_TOOL_NAME` branch of
// `AgentToolsModal.tsx`'s settings-button `onClick`. Still reads/writes
// `settings.jsSandbox` directly — this launcher's persistence key is
// unaffected by the capability-id migration (D9), since `jsSandbox` was
// never a `builtinToolOptions` entry.
const openJsSandboxSettings: SettingsLauncher = ({
  app,
  settings,
  setSettings,
  t,
}) => {
  new JsSandboxConfigModal(app, {
    title: t('settings.jsSandbox.openSettings', 'Configure analysis sandbox'),
    value: settings.jsSandbox,
    onChange: (next) =>
      void setSettings({
        ...settings,
        jsSandbox: next,
      }),
  }).open()
}

// Reads/writes `settings.mcp.builtinCapabilityOptions.terminal` — the
// capability-id key as of the `80_to_81` settings migration (D9,
// docs/plans/2026-08-15-tool-registry/phase2-migration.md D9). Was keyed by
// the old short tool name `terminal_command` before that migration landed.
const openTerminalSettings: SettingsLauncher = ({
  app,
  settings,
  setSettings,
  t,
}) => {
  new TerminalCommandConfigModal(app, {
    title: t(
      'settings.terminalCommand.openSettings',
      'Configure terminal command',
    ),
    value: settings.mcp.builtinCapabilityOptions.terminal?.blockedPrefixes ?? [
      ...DEFAULT_BLOCKED_PREFIXES,
    ],
    onChange: (next) =>
      void setSettings({
        ...settings,
        mcp: {
          ...settings.mcp,
          builtinCapabilityOptions: {
            ...settings.mcp.builtinCapabilityOptions,
            terminal: {
              ...settings.mcp.builtinCapabilityOptions.terminal,
              blockedPrefixes: next,
            },
          },
        },
      }),
  }).open()
}

// Ported verbatim from the unconditional `new WebSearchSettingsModal(app,
// plugin).open()` fallback at the bottom of `AgentToolsModal.tsx`'s
// settings-button `onClick` `if` chain (master.md §1.4c — that fallback is
// the exact silent-misroute bug this table exists to make impossible; this
// is now an explicit entry, not a default). `WebSearchSettingsModal` is the
// one dedicated-settings modal shaped `(app, plugin)` rather than
// `(app, { title, value, onChange })`, hence the `plugin` field on
// `CapabilitySettingsLauncherContext`.
const openWebSearchSettings: SettingsLauncher = ({ app, plugin }) => {
  if (!plugin) {
    throw new Error('WebSearchSettingsModal requires a plugin instance.')
  }
  new WebSearchSettingsModal(app, plugin).open()
}

/**
 * The exhaustive settings-entry wiring table (master.md §3.6 / D4).
 *
 * `satisfies Record<BuiltinCapabilityId, SettingsLauncher | null>` — not
 * `Partial` — so a capability with no launcher wired here is a compile
 * error, not a silent fallback. This directly rules out the bug documented
 * in master.md §1.4c: `AgentToolsModal.tsx:290-365`'s settings button
 * currently falls through, when none of its three `if`s match, to an
 * unconditional `new WebSearchSettingsModal(...)` — any capability that
 * declares `hasSettings: true` and forgets a branch there silently opens the
 * wrong settings panel instead of failing to compile.
 *
 * Only 2 entries today for the same reason `TOOL_RENDERERS` has 4: only
 * `memory` and `subagent_delegation` are registered in `CAPABILITIES` so
 * far (D2/D3). This table grows in lockstep with `CAPABILITIES` as D6 lands.
 */
export const CAPABILITY_SETTINGS_LAUNCHERS = {
  memory: null,
  subagent_delegation: openSubagentSettings,
  context_pruning: null,
  context_compaction: null,
  todo_list: null,
  user_questions: null,
  file_reading: null,
  file_editing: null,
  web_access: openWebSearchSettings,
  js_sandbox: openJsSandboxSettings,
  terminal: openTerminalSettings,
  vault_shell: null,
} satisfies Record<BuiltinCapabilityId, SettingsLauncher | null>
