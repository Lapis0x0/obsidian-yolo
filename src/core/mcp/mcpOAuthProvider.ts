import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import type { McpOAuthCredential } from './mcpOAuthStore'

type McpOAuthProviderOptions = {
  serverUrl: string
  redirectUrl: string
  credential?: McpOAuthCredential
  authorize?: (authorizationUrl: URL) => Promise<string>
  onCredentialChange?: (credential: McpOAuthCredential) => void | Promise<void>
}

const createState = (): string => {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

export class McpOAuthAuthorizationRequiredError extends Error {
  constructor() {
    super(
      'OAuth authorization is required. Open the server settings to connect.',
    )
    this.name = 'McpOAuthAuthorizationRequiredError'
  }
}

export class McpOAuthClientProvider implements OAuthClientProvider {
  private readonly serverUrl: string
  private readonly authorize?: (authorizationUrl: URL) => Promise<string>
  private readonly onCredentialChange?: (
    credential: McpOAuthCredential,
  ) => void | Promise<void>
  private readonly oauthState = createState()
  private credential: McpOAuthCredential
  private verifier: string | null = null
  private authorizationCodePromise: Promise<string> | null = null

  constructor(private readonly options: McpOAuthProviderOptions) {
    this.serverUrl = options.serverUrl
    this.authorize = options.authorize
    this.onCredentialChange = options.onCredentialChange
    this.credential = options.credential ?? {
      version: 1,
      serverUrl: options.serverUrl,
    }
  }

  get redirectUrl(): string {
    return this.options.redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'YOLO',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  state(): string {
    return this.oauthState
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.credential.clientInformation
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    this.credential = { ...this.credential, clientInformation }
    await this.persist()
  }

  tokens(): OAuthTokens | undefined {
    return this.credential.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.credential = { ...this.credential, tokens }
    await this.persist()
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.authorize) {
      throw new McpOAuthAuthorizationRequiredError()
    }
    this.authorizationCodePromise = this.authorize(authorizationUrl)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.verifier) {
      throw new Error('OAuth PKCE verifier is unavailable.')
    }
    return this.verifier
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.credential = { ...this.credential, discoveryState: state }
    await this.persist()
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.credential.discoveryState
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all' || scope === 'client') {
      delete this.credential.clientInformation
    }
    if (scope === 'all' || scope === 'tokens') {
      delete this.credential.tokens
    }
    if (scope === 'all' || scope === 'discovery') {
      delete this.credential.discoveryState
    }
    if (scope === 'all' || scope === 'verifier') {
      this.verifier = null
    }
    await this.persist()
  }

  async waitForAuthorizationCode(): Promise<string> {
    if (!this.authorizationCodePromise) {
      throw new Error('OAuth authorization did not start.')
    }
    return await this.authorizationCodePromise
  }

  getCredential(): McpOAuthCredential {
    return structuredClone(this.credential)
  }

  private async persist(): Promise<void> {
    await this.onCredentialChange?.(this.getCredential())
  }
}
