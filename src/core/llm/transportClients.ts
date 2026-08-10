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
