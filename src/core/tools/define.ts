import type {
  BuiltinCapabilityDefinition,
  BuiltinToolDefinition,
} from './types'

/**
 * Literal-preserving constructors for tool and capability definitions.
 *
 * HARD CONSTRAINT (master.md §6 "字面量保持" / phase1-skeleton.md D1):
 * every tool/capability definition MUST be built through `defineTool` /
 * `defineCapability` below. Writing `const x: BuiltinToolDefinition = {...}`
 * instead is FORBIDDEN — an explicit type annotation widens `name`/`id` to
 * plain `string`, which silently degrades `BuiltinToolName` /
 * `BuiltinCapabilityId` (registry.ts) to `string` and defeats every
 * completeness check (duplicate-name assertions, the two exhaustive wiring
 * tables in D4) this whole project exists to add. If you find yourself
 * reaching for a type annotation here, stop — use these instead.
 */

/**
 * `Name` is inferred from the literal `name` field via the `const` type
 * parameter modifier (TS 5.0+), which is what keeps it a literal (e.g.
 * `'memory_add'`) instead of widening to `string`.
 */
export const defineTool = <const Name extends string>(
  def: Omit<BuiltinToolDefinition, 'name'> & { name: Name },
): BuiltinToolDefinition<Name> => def

/**
 * `Tools` must be its own generic parameter (not left at
 * `BuiltinCapabilityDefinition`'s default `readonly BuiltinToolDefinition[]`)
 * for the same reason `Name` must be inferred above: only inferring it from
 * the actual `tools` array passed in preserves each member tool's literal
 * `name`. Without this, `capability.tools[number].name` would type-check as
 * plain `string` and `BuiltinToolName` would silently lose its union.
 */
export const defineCapability = <
  const Id extends string,
  const Tools extends readonly BuiltinToolDefinition[],
>(
  def: Omit<BuiltinCapabilityDefinition, 'id' | 'tools'> & {
    id: Id
    tools: Tools
  },
): BuiltinCapabilityDefinition<Id, Tools> => def
