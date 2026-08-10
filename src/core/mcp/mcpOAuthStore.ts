import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { App, normalizePath } from 'obsidian'
import path from 'path-browserify'

export type McpOAuthCredential = {
  version: 1
  serverUrl: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  discoveryState?: OAuthDiscoveryState
}

const CREDENTIAL_DIR_NAME = 'mcp-oauth'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isClientInformation = (
  value: unknown,
): value is OAuthClientInformationMixed =>
  isRecord(value) && typeof value.client_id === 'string'

const isTokens = (value: unknown): value is OAuthTokens =>
  isRecord(value) &&
  typeof value.access_token === 'string' &&
  typeof value.token_type === 'string'

const isDiscoveryState = (value: unknown): value is OAuthDiscoveryState =>
  isRecord(value) && typeof value.authorizationServerUrl === 'string'

const parseCredential = (value: unknown): McpOAuthCredential | null => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.serverUrl !== 'string'
  ) {
    return null
  }

  if (
    value.clientInformation !== undefined &&
    !isClientInformation(value.clientInformation)
  ) {
    return null
  }
  if (value.tokens !== undefined && !isTokens(value.tokens)) {
    return null
  }
  if (
    value.discoveryState !== undefined &&
    !isDiscoveryState(value.discoveryState)
  ) {
    return null
  }

  return {
    version: 1,
    serverUrl: value.serverUrl,
    ...(value.clientInformation
      ? { clientInformation: value.clientInformation }
      : {}),
    ...(value.tokens ? { tokens: value.tokens } : {}),
    ...(value.discoveryState ? { discoveryState: value.discoveryState } : {}),
  }
}

export class McpOAuthStore {
  private readonly dir: string

  constructor(
    private readonly app: App,
    pluginId: string,
  ) {
    this.dir = normalizePath(
      path.posix.join(
        this.app.vault.configDir,
        'plugins',
        pluginId,
        CREDENTIAL_DIR_NAME,
      ),
    )
  }

  async get(
    serverId: string,
    serverUrl?: string,
  ): Promise<McpOAuthCredential | null> {
    const file = this.getFile(serverId)
    if (!(await this.app.vault.adapter.exists(file))) {
      return null
    }

    try {
      const parsed = parseCredential(
        JSON.parse(await this.app.vault.adapter.read(file)),
      )
      if (
        !parsed ||
        (serverUrl !== undefined && parsed.serverUrl !== serverUrl)
      ) {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }

  async set(serverId: string, credential: McpOAuthCredential): Promise<void> {
    await this.ensureDir()
    await this.app.vault.adapter.write(
      this.getFile(serverId),
      JSON.stringify(credential, null, 2),
    )
  }

  async clear(serverId: string): Promise<void> {
    const file = this.getFile(serverId)
    if (await this.app.vault.adapter.exists(file)) {
      await this.app.vault.adapter.remove(file)
    }
  }

  private getFile(serverId: string): string {
    return normalizePath(
      path.posix.join(this.dir, `${encodeURIComponent(serverId)}.json`),
    )
  }

  private async ensureDir(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.dir))) {
      await this.app.vault.adapter.mkdir(this.dir)
    }
  }
}
