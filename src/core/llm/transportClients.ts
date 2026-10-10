import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'

import {
  ProviderErrorProtocol,
  createProviderErrorFetch,
} from './providerErrors'
import { createBrowserFetch, createDesktopNodeFetch } from './sdkFetch'

export type TransportClientSet<T> = {
  browserClient: T
  obsidianClient: T
  nodeClient: T
}

/**
 * Lets a provider that reuses another provider's request shaping (Copilot
 * reusing the OpenAI / Anthropic providers) take over the HTTP layer: the
 * wrapper receives each transport's fetch and returns the one the SDK client
 * calls.
 */
export type WrapTransportFetch = (transportFetch: typeof fetch) => typeof fetch

export function createTransportClients<T>(
  createClient: (transportFetch: typeof fetch) => T,
  context: {
    providerId: string
    protocol: ProviderErrorProtocol
  },
): TransportClientSet<T> {
  return {
    browserClient: createClient(
      createProviderErrorFetch(createBrowserFetch(), {
        ...context,
        transportMode: 'browser',
      }),
    ),
    obsidianClient: createClient(
      createProviderErrorFetch(createObsidianFetch(), {
        ...context,
        transportMode: 'obsidian',
      }),
    ),
    nodeClient: createClient(
      createProviderErrorFetch(createDesktopNodeFetch(), {
        ...context,
        transportMode: 'node',
      }),
    ),
  }
}
