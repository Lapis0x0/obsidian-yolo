import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { defineCapability, defineTool } from './define'
import {
  type BuiltinCapabilityId,
  type BuiltinToolName,
  listBuiltinTools,
  listCapabilities,
} from './registry'

/**
 * Guards the single assumption every completeness check in this subsystem
 * rests on: `BuiltinToolName` / `BuiltinCapabilityId` are exact literal
 * unions, not `string`.
 *
 * If either ever widens to `string`, nothing visibly breaks — the duplicate
 * assertions still run, and both exhaustive wiring tables
 * (`TOOL_RENDERERS satisfies Record<BuiltinToolName, ToolRenderer>`,
 * `CAPABILITY_SETTINGS_LAUNCHERS satisfies Record<BuiltinCapabilityId, ...>`)
 * keep compiling while silently accepting anything. That is the exact
 * silent-drift failure this refactor exists to remove, so it gets a probe of
 * its own rather than being left implicit.
 *
 * The assertions below are compile-time: `Exact` fails to instantiate unless
 * both sides are mutually assignable, so `npm run type:check` is what
 * actually enforces this file. The `it` blocks only keep the union and the
 * runtime registry from drifting apart.
 */

type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

const assertExact = <_T extends true>(): void => undefined

const EXPECTED_TOOL_NAMES = [
  'fs_read',
  'fs_edit',
  'fs_write',
  'bash',
  'memory_add',
  'memory_update',
  'memory_delete',
  'context_prune_tool_results',
  'context_compact',
  'todo_write',
  'ask_user_question',
  'web_search',
  'web_scrape',
  'js_eval',
  'terminal_command',
  'delegate_subagent',
] as const

const EXPECTED_CAPABILITY_IDS = [
  'file_reading',
  'vault_shell',
  'file_editing',
  'context_pruning',
  'context_compaction',
  'user_questions',
  'todo_list',
  'memory',
  'web_access',
  'js_sandbox',
  'terminal',
  'subagent_delegation',
] as const

// The load-bearing assertions. Widening either union to `string` breaks
// these two lines and nothing else — which is the whole point.
assertExact<Exact<BuiltinToolName, (typeof EXPECTED_TOOL_NAMES)[number]>>()
assertExact<
  Exact<BuiltinCapabilityId, (typeof EXPECTED_CAPABILITY_IDS)[number]>
>()

// `defineTool` / `defineCapability` must preserve literals *without* a
// `const` type-parameter modifier: the repo's esbuild (0.17.3) predates TS
// 5.0 `const` type parameters, so reintroducing one type-checks under tsc
// but fails `npm run build` at bundle time. A type parameter merely
// *constrained to* `string` already suppresses literal widening, which is
// what these two probes pin.
const probeTool = defineTool({
  name: 'probe_tool',
  getMcpTool: () => ({ description: '', inputSchema: { type: 'object' } }),
  chatLabel: { key: 'probe', fallback: 'probe' },
  execute: () =>
    Promise.resolve({ status: ToolCallResponseStatus.Success, text: '' }),
})
assertExact<Exact<(typeof probeTool)['name'], 'probe_tool'>>()

const _probeCapability = defineCapability({
  id: 'probe_capability',
  label: { key: 'probe', fallback: 'probe' },
  category: 'context',
  defaultEnabled: false,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: false,
  tools: [probeTool],
})
assertExact<Exact<(typeof _probeCapability)['id'], 'probe_capability'>>()
assertExact<
  Exact<(typeof _probeCapability)['tools'][number]['name'], 'probe_tool'>
>()

describe('built-in tool registry literal preservation', () => {
  it('the runtime registry matches the pinned tool-name union', () => {
    expect(
      listBuiltinTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([...EXPECTED_TOOL_NAMES].sort())
  })

  it('the runtime registry matches the pinned capability-id union', () => {
    expect(listCapabilities().map((capability) => capability.id)).toEqual([
      ...EXPECTED_CAPABILITY_IDS,
    ])
  })
})
