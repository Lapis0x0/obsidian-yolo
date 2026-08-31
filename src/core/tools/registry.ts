import { CAPABILITIES } from './capabilities'
import type {
  BuiltinCapabilityDefinition,
  BuiltinToolDefinition,
} from './types'

/**
 * The finite set of capability ids / tool names, derived structurally from
 * the concrete `CAPABILITIES` array rather than hand-maintained. This is the
 * root every completeness check in this project hangs off: the two exhaustive
 * UI wiring tables (`TOOL_RENDERERS` / `CAPABILITY_SETTINGS_LAUNCHERS`, D4)
 * `satisfies Record<BuiltinToolName, ...>` / `Record<BuiltinCapabilityId, ...>`
 * against these unions, so forgetting to wire up a new tool/capability is a
 * compile error instead of a silent gap.
 *
 * If either of these ever infers as `string` instead of a literal union,
 * something upstream (a `defineTool`/`defineCapability` call written with an
 * explicit `: BuiltinToolDefinition` annotation, most likely) has widened a
 * literal — see define.ts's doc comment.
 */
export type BuiltinCapabilityId = (typeof CAPABILITIES)[number]['id']
export type BuiltinToolName =
  (typeof CAPABILITIES)[number]['tools'][number]['name']

// `CAPABILITIES` is a heterogeneous tuple — each element has its own literal
// `Id`/`Tools` type parameters (that's the whole point, see define.ts) — so
// `.flatMap` over it directly cannot unify a single element type and fails
// to typecheck once there is more than one capability. Widening to the
// (structurally compatible) default-generic view here is a purely local,
// runtime-only computation: it does not touch `BuiltinCapabilityId` /
// `BuiltinToolName` above, which are computed at the type level straight
// from `CAPABILITIES`'s own literal type, not from this array.
const BUILTIN_TOOLS: readonly BuiltinToolDefinition[] = (
  CAPABILITIES as readonly BuiltinCapabilityDefinition[]
).flatMap((capability) => capability.tools)

/**
 * Throws if `values` contains a duplicate. Exported so it can be unit tested
 * directly against constructed duplicate/non-duplicate arrays — the real
 * `CAPABILITIES` array never has duplicates by construction, so the only way
 * to exercise the "found a duplicate" branch is to call this directly rather
 * than via the module-level assertions below.
 */
export function assertNoDuplicates(
  values: readonly string[],
  kind: string,
): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${kind}: "${value}"`)
    }
    seen.add(value)
  }
}

// Build-time assertions: capability ids and tool names must each be unique.
// A `Record<K, V>` literal silently de-duplicates repeated keys, so the two
// exhaustive wiring tables in D4 would NOT catch a duplicate on their own —
// this is the only place that does.
assertNoDuplicates(
  CAPABILITIES.map((capability) => capability.id),
  'capability id',
)
assertNoDuplicates(
  BUILTIN_TOOLS.map((tool) => tool.name),
  'tool name',
)

export const getCapability = (
  id: string,
): BuiltinCapabilityDefinition | undefined =>
  CAPABILITIES.find((capability) => capability.id === id)

export const getToolDefinition = (
  name: string,
): BuiltinToolDefinition | undefined =>
  BUILTIN_TOOLS.find((tool) => tool.name === name)

export const getCapabilityForTool = (
  name: string,
): BuiltinCapabilityDefinition | undefined =>
  CAPABILITIES.find((capability) =>
    capability.tools.some((tool) => tool.name === name),
  )

export const listCapabilities = (): readonly BuiltinCapabilityDefinition[] =>
  CAPABILITIES

export const listBuiltinTools = (): readonly BuiltinToolDefinition[] =>
  BUILTIN_TOOLS

export const isBuiltinToolName = (name: string): name is BuiltinToolName =>
  BUILTIN_TOOLS.some((tool) => tool.name === name)

export const isBuiltinCapabilityId = (id: string): id is BuiltinCapabilityId =>
  CAPABILITIES.some((capability) => capability.id === id)
