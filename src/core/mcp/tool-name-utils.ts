import { InvalidToolNameException } from './exception'

const DEFAULT_DELIMITER = '__'

/**
 * Namespace reserved for module chat mode in-process tool servers (see
 * `moduleChatModeRegistry.ts`), named `module-mode-<moduleId>-<modeId>`.
 * User-configured MCP servers may not use this prefix — enforced by default
 * in `validateServerName` — so a module's chat mode server can never be
 * shadowed or spoofed by hand-written or imported server config.
 */
export const RESERVED_MODULE_MODE_SERVER_PREFIX = 'module-mode-'

/**
 * Validates that a server name follows the required format and doesn't contain the delimiter
 * @param name Server name to validate
 * @param options.delimiter Optional custom delimiter
 * @param options.allowReservedPrefix Permits `RESERVED_MODULE_MODE_SERVER_PREFIX`.
 * Only the host's own in-process registration path (`registerInProcessServer`)
 * should pass this — every user-facing config write/validation path (the MCP
 * server form, `connectServer`) must keep the default rejection.
 */
export function validateServerName(
  name: string,
  options: { delimiter?: string; allowReservedPrefix?: boolean } = {},
): void {
  const delimiter = options.delimiter ?? DEFAULT_DELIMITER
  // OpenAI only allows alphanumeric characters, underscores, and hyphens in the tool name
  const regex = /^[a-zA-Z0-9_-]+$/
  if (!regex.test(name)) {
    throw new Error(
      `Invalid MCP server name: ${name}. Only alphanumeric characters, underscores, and hyphens are allowed.`,
    )
  }
  // Server names cannot contain it to ensure proper parsing and formatting
  if (name.includes(delimiter)) {
    throw new Error(
      `MCP server name ${name} should not contain the delimiter ${delimiter}.`,
    )
  }
  if (
    !options.allowReservedPrefix &&
    name.startsWith(RESERVED_MODULE_MODE_SERVER_PREFIX)
  ) {
    throw new Error(
      `MCP server name ${name} uses the reserved "${RESERVED_MODULE_MODE_SERVER_PREFIX}" prefix.`,
    )
  }
}

/**
 * Parses a combined tool name into server name and tool name components
 * @param name Combined tool name to parse
 * @param delimiter Optional custom delimiter
 */
export function parseToolName(
  name: string,
  delimiter: string = DEFAULT_DELIMITER,
): {
  serverName: string
  toolName: string
} {
  const regex = new RegExp(`^(.+?)${delimiter}(.+)$`)
  const match = name.match(regex)

  if (!match || match.length < 3) {
    throw new InvalidToolNameException(name)
  }

  const serverName = match[1]
  const toolName = match[2]

  if (!serverName || !toolName) {
    throw new InvalidToolNameException(name)
  }

  return { serverName, toolName }
}

/**
 * Creates a combined tool name from server name and tool name components
 * @param serverName Server name component
 * @param toolName Tool name component
 * @param delimiter Optional custom delimiter
 */
export function getToolName(
  serverName: string,
  toolName: string,
  delimiter: string = DEFAULT_DELIMITER,
): string {
  return `${serverName}${delimiter}${toolName}`
}
