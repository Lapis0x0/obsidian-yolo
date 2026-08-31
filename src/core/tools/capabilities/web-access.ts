import { defineCapability } from '../define'
import { webScrapeDefinition } from '../web_scrape/definition'
import { webSearchDefinition } from '../web_search/definition'

// label/description copied from the `web_ops` group entry in
// `builtinToolUiMeta.ts` (`WEB_OPS_GROUP_TOOL_NAME`'s label/desc) and
// `BUILTIN_TOOL_CATEGORY_MAP[WEB_OPS_GROUP_TOOL_NAME]` (`'external'`). The
// i18n keys are unchanged from the existing locale entries (master.md §5).
// `id: 'web_access'` is a new capability id (decision 16), independent of
// the old `web_ops` group-name string.
//
// defaultEnabled cross-checked against the pre-refactor sources: neither
// `web_search` nor `web_scrape` is in `BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES`
// -> defaultEnabled: true. Not in `ALWAYS_ALLOW_DISABLED_TOOL_NAMES` ->
// allowAlwaysAllow: true. Not in `FULL_ACCESS_LOCAL_TOOLS` /
// `REQUIRE_APPROVAL_LOCAL_TOOLS` / the bash special-case -> defaultMode
// falls through to 'full_access'.
//
// hasSettings: true — ⚠️ this is the ONE capability where v1's basis
// document got the count wrong (master.md §1.4c / phase2-migration.md D6
// batch 5 note): `AgentToolsModal.tsx:117`'s `hasSettings` ternary only
// names three tools (js_sandbox/terminal/subagent), but `web_ops`'s
// group-row object is constructed separately at `:164` with
// `hasSettings: true` hardcoded — so today's settings button for this row
// opens `WebSearchSettingsModal` too, just via the fallback branch at the
// bottom of the button's `onClick` `if` chain rather than an explicit
// match (§1.4c: the exact bug this whole registry exists to make
// impossible). `CAPABILITY_SETTINGS_LAUNCHERS.web_access` (D4/D6 batch 5)
// wires this explicitly instead — see `capabilitySettingsLaunchers.ts`.
export const webAccessCapability = defineCapability({
  id: 'web_access',
  label: {
    key: 'settings.agent.builtinWebOpsLabel',
    fallback: 'Web Search Toolset',
  },
  description: {
    key: 'settings.agent.builtinWebOpsDesc',
    fallback:
      'Grouped web tools: web_search for queries and web_scrape for single-page full content.',
  },
  category: 'external',
  defaultEnabled: true,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: true,
  tools: [webSearchDefinition, webScrapeDefinition],
})
