import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'

import { createBrowserFetch, createDesktopNodeFetch } from './sdkFetch'

export type TransportClientSet<T> = {
  browserClient: T
  obsidianClient: T
  nodeClient: T
}

export function createTransportClients<T>(
  createClient: (transportFetch: typeof fetch) => T,
): TransportClientSet<T> {
  return {
    browserClient: createClient(createBrowserFetch()),
    obsidianClient: createClient(createObsidianFetch()),
    nodeClient: createClient(createDesktopNodeFetch()),
  }
}
