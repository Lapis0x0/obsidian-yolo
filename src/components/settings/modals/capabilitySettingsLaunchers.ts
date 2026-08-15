import { App } from 'obsidian'

import type { BuiltinCapabilityId } from '../../../core/tools/registry'
import type { YoloSettings } from '../../../settings/schema/setting.types'

import { SubagentConfigModal } from './SubagentConfigModal'

type TranslateFn = (key: string, fallback?: string) => string

/**
 * Context a capability's settings launcher needs to open its modal. Kept
 * minimal to what `openSubagentSettings` actually uses today. Other
 * capabilities with `hasSettings: true` (js_sandbox, terminal, web_access)
 * land in D6 and may need more (e.g. a `plugin` reference for
 * `WebSearchSettingsModal`, which takes `(app, plugin)`) — an additive,
 * non-breaking extension of this type when that happens.
 */
export type CapabilitySettingsLauncherContext = {
  app: App
  settings: YoloSettings
  setSettings: (settings: YoloSettings) => Promise<boolean>
  t: TranslateFn
}

export type SettingsLauncher = (ctx: CapabilitySettingsLauncherContext) => void

// Ported verbatim from the `tool.id === DELEGATE_SUBAGENT_TOOL_SHORT_NAME`
// branch of `AgentToolsModal.tsx`'s settings-button `onClick` (:335-364).
// Still reads/writes `settings.mcp.builtinToolOptions.delegate_subagent` —
// the OLD short-tool-name persistence key. Migrating persistence to a
// capability-id key is D9; this launcher must keep using the current key so
// this phase stays zero-behavior-change.
const openSubagentSettings: SettingsLauncher = ({
  app,
  settings,
  setSettings,
  t,
}) => {
  new SubagentConfigModal(app, {
    title: t('settings.subagent.openSettings', 'Configure subagent models'),
    settings,
    value: settings.mcp.builtinToolOptions.delegate_subagent ?? {},
    onChange: (next) =>
      void setSettings({
        ...settings,
        mcp: {
          ...settings.mcp,
          builtinToolOptions: {
            ...settings.mcp.builtinToolOptions,
            delegate_subagent: {
              ...settings.mcp.builtinToolOptions.delegate_subagent,
              ...next,
            },
          },
        },
      }),
  }).open()
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
} satisfies Record<BuiltinCapabilityId, SettingsLauncher | null>
