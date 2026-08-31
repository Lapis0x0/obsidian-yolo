// D6b's own verification point (phase2-migration.md "工具目录接线"):
// `getLocalFileTools()` (`src/core/mcp/localFileTools.ts`) used to return a
// hand-written literal array — a second, independent truth source from the
// registry's `getMcpTool(ctx)` projections that D6 batches 1-7 built and
// left dangling. This file locks in the two things D6b promises:
//
//   1. Order: the model-facing tool list must not silently reorder. The
//      exact pre-D6b literal-array order is asserted per option combo below.
//   2. Content: each entry's schema must equal that tool's own
//      `getMcpTool(ctx)` (proving the catalog is actually built from the
//      registry, not a parallel copy).
//
// Individual tools already have their own drift-guard tests (e.g.
// fs-read-equivalence.test.ts, bash-equivalence.test.ts); this file is the
// one place that checks the *whole* catalog — order and membership — across
// the option combinations that matter: no options, a text-only model, a
// vision model, a PDF model, and the `bash-engine` runtime component on/off
// (see bash-equivalence.test.ts's own "D6b: bash-engine gate unified"
// `describe` block for the deeper bash-specific coverage of that last axis).

jest.mock('obsidian')

import type { ChatModelModality } from '../../types/chat-model.types'
import { getLocalFileTools } from '../mcp/localFileTools'
import { setRuntimeComponentEnabledOverrideForTests } from '../runtime-components/runtimeComponentAccess'

import { getToolDefinition } from './registry'

afterEach(() => {
  setRuntimeComponentEnabledOverrideForTests(null)
})

// The pre-D6b literal array's exact order (`bash` included — every case in
// this file that doesn't explicitly disable the runtime component runs with
// it enabled, matching the "无 options" baseline other equivalence suites
// use).
const EXPECTED_ORDER_WITH_BASH = [
  'context_prune_tool_results',
  'context_compact',
  'fs_read',
  'fs_edit',
  'fs_write',
  'bash',
  'memory_add',
  'memory_update',
  'memory_delete',
  'web_search',
  'web_scrape',
  'js_eval',
  'terminal_command',
  'delegate_subagent',
  'ask_user_question',
  'todo_write',
]

function expectCatalogMatchesRegistry(
  options:
    | { vaultBasePath?: string; chatModelModalities?: ChatModelModality[] }
    | undefined,
  expectedOrder: readonly string[],
): void {
  const tools = getLocalFileTools(options)
  expect(tools.map((tool) => tool.name)).toEqual(expectedOrder)

  for (const tool of tools) {
    const definition = getToolDefinition(tool.name)
    expect(definition).toBeDefined()
    const { name: _name, ...rest } = tool
    expect(rest).toEqual(
      definition!.getMcpTool({
        vaultBasePath: options?.vaultBasePath,
        chatModelModalities: options?.chatModelModalities,
      }),
    )
  }
}

describe('getLocalFileTools() catalog: order and content match the registry (D6b)', () => {
  beforeEach(() => {
    setRuntimeComponentEnabledOverrideForTests(() => true)
  })

  it('no options', () => {
    expectCatalogMatchesRegistry(undefined, EXPECTED_ORDER_WITH_BASH)
  })

  it('text-only model (empty modalities)', () => {
    expectCatalogMatchesRegistry(
      { chatModelModalities: [] },
      EXPECTED_ORDER_WITH_BASH,
    )
  })

  it('vision model', () => {
    expectCatalogMatchesRegistry(
      { chatModelModalities: ['vision'] },
      EXPECTED_ORDER_WITH_BASH,
    )
  })

  it('pdf model', () => {
    expectCatalogMatchesRegistry(
      { chatModelModalities: ['pdf'] },
      EXPECTED_ORDER_WITH_BASH,
    )
  })

  it('vaultBasePath supplied alongside modalities', () => {
    expectCatalogMatchesRegistry(
      { vaultBasePath: '/vault', chatModelModalities: ['vision', 'pdf'] },
      EXPECTED_ORDER_WITH_BASH,
    )
  })
})

describe('getLocalFileTools() catalog: bash-engine on/off (D6b)', () => {
  it('bash-engine on: bash appears in its legacy position', () => {
    setRuntimeComponentEnabledOverrideForTests(() => true)
    expectCatalogMatchesRegistry(undefined, EXPECTED_ORDER_WITH_BASH)
  })

  it('bash-engine off: bash is omitted, every other tool keeps its legacy order', () => {
    setRuntimeComponentEnabledOverrideForTests(() => false)
    expectCatalogMatchesRegistry(
      undefined,
      EXPECTED_ORDER_WITH_BASH.filter((name) => name !== 'bash'),
    )
  })
})
