/* eslint-disable import/no-nodejs-modules -- desktop-only module, only reached through the dynamic import in sdkFetch.ts behind the Node transport */
import * as http from 'node:http'
import * as https from 'node:https'
/* eslint-enable import/no-nodejs-modules */

import { Agent, type AgentConnectOpts } from 'agent-base'

export type GetProxyForUrl = (url: string) => string | Promise<string>

type ProxyAgentConstructor = new (proxy: string) => http.Agent

const loadHttpProxyAgent = async (): Promise<ProxyAgentConstructor> =>
  (await import('http-proxy-agent')).HttpProxyAgent
const loadHttpsProxyAgent = async (): Promise<ProxyAgentConstructor> =>
  (await import('https-proxy-agent')).HttpsProxyAgent
const loadSocksProxyAgent = async (): Promise<ProxyAgentConstructor> =>
  (await import('socks-proxy-agent')).SocksProxyAgent

/**
 * Proxy protocol → [agent for plain HTTP targets, agent for HTTPS or
 * WebSocket targets]. Same table as proxy-agent@6.5.0 minus its `pac+*`
 * entries: our proxy strings come either from the system resolver (which
 * only emits http/https/socks4/socks5 or direct) or verbatim from env vars,
 * and supporting `pac+` from env would pull a whole JS engine into main.js.
 */
const PROXY_AGENTS: Record<
  string,
  readonly [
    () => Promise<ProxyAgentConstructor>,
    () => Promise<ProxyAgentConstructor>,
  ]
> = {
  http: [loadHttpProxyAgent, loadHttpsProxyAgent],
  https: [loadHttpProxyAgent, loadHttpsProxyAgent],
  socks: [loadSocksProxyAgent, loadSocksProxyAgent],
  socks4: [loadSocksProxyAgent, loadSocksProxyAgent],
  socks4a: [loadSocksProxyAgent, loadSocksProxyAgent],
  socks5: [loadSocksProxyAgent, loadSocksProxyAgent],
  socks5h: [loadSocksProxyAgent, loadSocksProxyAgent],
}

// Matches proxy-agent's LRU bound. Real keys are "target protocol × proxy
// URL", so in practice a handful; the bound only guards against a PAC that
// rotates proxies per host.
const MAX_CACHED_AGENTS = 20

/**
 * Per-request proxy dispatcher: resolves the proxy for each request URL and
 * hands the request to a cached http/https/socks proxy agent, or to a plain
 * `http.Agent` / `https.Agent` when the policy says DIRECT. Replicates
 * proxy-agent@6.5.0's non-PAC behavior.
 */
export class ProxyDispatcherAgent extends Agent {
  private readonly getProxyForUrl: GetProxyForUrl
  private readonly httpAgent = new http.Agent()
  private readonly httpsAgent = new https.Agent()
  // Map iteration order is insertion order; re-inserting on hit makes the
  // first key the least recently used.
  private readonly cache = new Map<string, http.Agent>()

  constructor(getProxyForUrl: GetProxyForUrl) {
    super()
    this.getProxyForUrl = getProxyForUrl
  }

  async connect(
    req: http.ClientRequest,
    opts: AgentConnectOpts,
  ): Promise<http.Agent> {
    const { secureEndpoint } = opts
    const isWebSocket = req.getHeader('upgrade') === 'websocket'
    const protocol = secureEndpoint
      ? isWebSocket
        ? 'wss:'
        : 'https:'
      : isWebSocket
        ? 'ws:'
        : 'http:'
    const host = String(req.getHeader('host'))
    const url = new URL(req.path, `${protocol}//${host}`).href

    const proxy = await this.getProxyForUrl(url)
    if (!proxy) {
      return secureEndpoint ? this.httpsAgent : this.httpAgent
    }

    const cacheKey = `${protocol}+${proxy}`
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      return cached
    }

    const proxyProtocol = new URL(proxy).protocol.replace(':', '')
    const loaders = Object.prototype.hasOwnProperty.call(
      PROXY_AGENTS,
      proxyProtocol,
    )
      ? PROXY_AGENTS[proxyProtocol]
      : undefined
    if (!loaders) {
      throw new Error(`Unsupported protocol for proxy URL: ${proxy}`)
    }
    const AgentConstructor =
      await loaders[secureEndpoint || isWebSocket ? 1 : 0]()
    // A concurrent request for the same key may have filled the slot while we
    // awaited the loader; reuse it instead of replacing an agent in use.
    const raced = this.cache.get(cacheKey)
    if (raced) return raced
    const agent = new AgentConstructor(proxy)
    this.cache.set(cacheKey, agent)
    if (this.cache.size > MAX_CACHED_AGENTS) {
      const [oldestKey, oldestAgent] = this.cache.entries().next().value as [
        string,
        http.Agent,
      ]
      this.cache.delete(oldestKey)
      oldestAgent.destroy()
    }
    return agent
  }

  destroy(): void {
    for (const agent of this.cache.values()) {
      agent.destroy()
    }
    this.cache.clear()
    super.destroy()
  }
}
