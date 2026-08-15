// Generic tool-argument parsing and result-formatting helpers shared by more
// than one built-in tool implementation (both migrated `core/tools/*`
// definitions and the still-live `callLocalFileTool` switch in
// `core/mcp/localFileTools.ts`). Kept here — not inside any single tool's
// directory — because each of these has multiple consumers (see
// phase2-migration.md D6 "注意": "谁用它谁收留" only moves a helper into a
// tool's own directory when that tool is its *only* consumer).
//
// `localFileTools.ts` imports these back from here (see that file's own
// import block) rather than this module reaching back into it. That
// direction is required to keep `core/tools/*` from re-entering the
// pre-existing circular dependency between `core/mcp/mcpManager.ts` and
// `core/agent/*` (docs/plans/2026-08-15-tool-registry/master.md, D6a fix).

export const asErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return typeof error === 'string' ? error : JSON.stringify(error)
}

export const formatJsonResult = (payload: unknown): string => {
  return JSON.stringify(payload, null, 2)
}

export const getTextArg = (
  args: Record<string, unknown>,
  key: string,
): string => {
  const value = args[key]
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string.`)
  }
  return value
}

export const getOptionalTextArg = (
  args: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = args[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string.`)
  }
  return value
}

export const getStringArrayArg = (
  args: Record<string, unknown>,
  key: string,
): string[] => {
  const value = args[key]
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array of strings.`)
  }
  if (value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings.`)
  }
  return value
}

export const getRecordArrayArg = (
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] => {
  const value = args[key]
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array.`)
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`${key}[${index}] must be an object.`)
    }
    return item as Record<string, unknown>
  })
}

// Used by `fs_read`'s line-range parsing (`endLine`) and by the still-live
// `bash`/`terminal_command` switch cases (`sessionId`, `timeoutSeconds`,
// `tailLines`, `tailBytes`) — a genuine multi-consumer helper, not a
// fs_read exclusive.
export const getOptionalBoundedIntegerArg = ({
  args,
  key,
  min,
  max,
}: {
  args: Record<string, unknown>
  key: string
  min: number
  max: number
}): number | undefined => {
  const value = args[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`)
  }
  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}.`)
  }
  return value
}

// Shared content-size cap: `fs_read`'s file-size guard, `fs_write`'s content
// guard, and `fs_edit`'s snapshot threshold all check against this same
// value — a genuine multi-consumer constant, not a fs_read exclusive.
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024
