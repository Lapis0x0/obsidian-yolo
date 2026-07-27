import { App } from 'obsidian'

import { openExternalLink } from '../../utils/openExternalLink'

import { McpOAuthCallbackServer } from './mcpOAuthCallbackServer'
import { McpOAuthClientProvider } from './mcpOAuthProvider'
import { McpOAuthCredential, McpOAuthStore } from './mcpOAuthStore'

type DraftSession = {
  serverUrl: string
  provider: McpOAuthClientProvider
}

export class McpOAuthController {
  private readonly store: McpOAuthStore
  private readonly callbackServer = new McpOAuthCallbackServer(openExternalLink)
  private readonly drafts = new Map<string, DraftSession>()

  constructor(app: App, pluginId: string) {
    this.store = new McpOAuthStore(app, pluginId)
  }

  async createDraftProvider(
    draftId: string,
    serverUrl: string,
  ): Promise<McpOAuthClientProvider> {
    this.discardDraft(draftId)
    const redirectUrl = await this.callbackServer.getRedirectUrl()
    const provider = new McpOAuthClientProvider({
      serverUrl,
      redirectUrl,
      authorize: (authorizationUrl) =>
        this.callbackServer.authorize(draftId, authorizationUrl),
    })
    this.drafts.set(draftId, { serverUrl, provider })
    return provider
  }

  async createRuntimeProvider(
    serverId: string,
    serverUrl: string,
  ): Promise<McpOAuthClientProvider> {
    const redirectUrl = await this.callbackServer.getRedirectUrl()
    return new McpOAuthClientProvider({
      serverUrl,
      redirectUrl,
      credential: (await this.store.get(serverId, serverUrl)) ?? {
        version: 1,
        serverUrl,
      },
      onCredentialChange: (credential) => this.store.set(serverId, credential),
    })
  }

  getDraftCredential(draftId: string): McpOAuthCredential | null {
    return this.drafts.get(draftId)?.provider.getCredential() ?? null
  }

  async hasCredential(serverId: string, serverUrl: string): Promise<boolean> {
    return (await this.store.get(serverId, serverUrl))?.tokens !== undefined
  }

  async commitDraft(
    draftId: string,
    serverId: string,
  ): Promise<() => Promise<void>> {
    const draft = this.drafts.get(draftId)
    const credential = draft?.provider.getCredential()
    if (!draft || !credential?.tokens) {
      throw new Error('Complete OAuth authorization before saving the server.')
    }

    const previous = await this.store.get(serverId)
    await this.store.set(serverId, credential)
    this.drafts.delete(draftId)
    return async () => {
      if (previous) {
        await this.store.set(serverId, previous)
      } else {
        await this.store.clear(serverId)
      }
    }
  }

  async moveCredential(
    fromServerId: string,
    toServerId: string,
    serverUrl: string,
  ): Promise<(() => Promise<void>) | null> {
    if (fromServerId === toServerId) return null
    const credential = await this.store.get(fromServerId, serverUrl)
    if (!credential) return null

    const previousTarget = await this.store.get(toServerId)
    await this.store.set(toServerId, credential)
    return async () => {
      if (previousTarget) {
        await this.store.set(toServerId, previousTarget)
      } else {
        await this.store.clear(toServerId)
      }
    }
  }

  discardDraft(draftId: string): void {
    this.callbackServer.cancelOwner(draftId)
    this.drafts.delete(draftId)
  }

  async clearCredential(serverId: string): Promise<void> {
    await this.store.clear(serverId)
  }

  close(): void {
    for (const draftId of this.drafts.keys()) {
      this.discardDraft(draftId)
    }
    this.callbackServer.close()
  }
}
