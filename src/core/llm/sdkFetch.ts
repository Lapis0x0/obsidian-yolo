// eslint-disable-next-line import/no-nodejs-modules -- Desktop transport needs RequestOptions agent typing from Node HTTP
import type { RequestOptions } from 'node:http'

import { Platform } from 'obsidian'

import type { RequestTransportMode } from '../../types/provider.types'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'

let nodeFetchPromise: Promise<typeof fetch> | null = null
let desktopProxyAgent: RequestOptions['agent'] | null | undefined

type NodeFetchRequestInit = RequestInit & {
  agent?: RequestOptions['agent']
}

export type DesktopNodeFetchOptions = {
  agent?: RequestOptions['agent']
}

type ProxyEnv = Partial<
  Record<
    | 'HTTP_PROXY'
    | 'HTTPS_PROXY'
    | 'ALL_PROXY'
    | 'NO_PROXY'
    | 'http_proxy'
    | 'https_proxy'
    | 'all_proxy'
    | 'no_proxy',
    string
  >
>

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const

const withProcessEnv = <T>(env: NodeJS.ProcessEnv, cb: () => T): T => {
  const previousEnv = process.env
  process.env = env
  try {
    return cb()
  } finally {
    process.env = previousEnv
  }
}

const hasProxyEnv = (env: NodeJS.ProcessEnv): boolean =>
  PROXY_ENV_KEYS.some((key) => typeof env[key] === 'string' && env[key]?.trim())

const setProxyEnvValue = (
  env: ProxyEnv,
  key: 'HTTP_PROXY' | 'HTTPS_PROXY' | 'ALL_PROXY' | 'NO_PROXY',
  value?: string,
): void => {
  const trimmed = value?.trim()
  if (!trimmed) {
    return
  }

  env[key] = trimmed
  env[key.toLowerCase() as Lowercase<typeof key>] = trimmed
}

export const parseMacOsProxyEnv = (output: string): ProxyEnv => {
  const entries = new Map<string, string>()
  const exceptions: string[] = []
  let inExceptionsList = false

  for (const line of output.split(/\r?\n/)) {
    if (inExceptionsList) {
      const exceptionMatch = line.match(/^\s*\d+\s*:\s*(.+?)\s*$/)
      if (exceptionMatch) {
        exceptions.push(exceptionMatch[1])
        continue
      }

      if (line.trim() === '}') {
        inExceptionsList = false
      }
    }

    const entryMatch = line.match(/^\s*([A-Za-z0-9]+)\s*:\s*(.+?)\s*$/)
    if (entryMatch) {
      const [, key, value] = entryMatch
      entries.set(key, value)
      inExceptionsList = key === 'ExceptionsList'
      continue
    }
  }

  const env: ProxyEnv = {}
  const httpProxy = entries.get('HTTPProxy')
  const httpPort = entries.get('HTTPPort')
  const httpsProxy = entries.get('HTTPSProxy')
  const httpsPort = entries.get('HTTPSPort')
  const socksProxy = entries.get('SOCKSProxy')
  const socksPort = entries.get('SOCKSPort')

  if (entries.get('HTTPEnable') === '1' && httpProxy && httpPort) {
    setProxyEnvValue(env, 'HTTP_PROXY', `http://${httpProxy}:${httpPort}`)
  }

  if (entries.get('HTTPSEnable') === '1' && httpsProxy && httpsPort) {
    setProxyEnvValue(env, 'HTTPS_PROXY', `http://${httpsProxy}:${httpsPort}`)
  }

  if (
    !env.ALL_PROXY &&
    entries.get('SOCKSEnable') === '1' &&
    socksProxy &&
    socksPort
  ) {
    setProxyEnvValue(env, 'ALL_PROXY', `socks5://${socksProxy}:${socksPort}`)
  }

  if (exceptions.length > 0) {
    setProxyEnvValue(env, 'NO_PROXY', exceptions.join(','))
  }

  return env
}

const readMacOsProxyEnv = async (): Promise<ProxyEnv> => {
  if (process.platform !== 'darwin') {
    return {}
  }

  try {
    // eslint-disable-next-line import/no-nodejs-modules -- Desktop transport reads macOS proxy settings via scutil
    const { execFileSync } = await import('node:child_process')
    const output = execFileSync('scutil', ['--proxy'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return parseMacOsProxyEnv(output)
  } catch {
    return {}
  }
}

export const resolveDesktopProxyEnv = (
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProxyEnv> => {
  if (hasProxyEnv(env)) {
    return Promise.resolve({})
  }

  return readMacOsProxyEnv()
}

const getDesktopProxyAgent = async (): Promise<
  RequestOptions['agent'] | undefined
> => {
  if (desktopProxyAgent !== undefined) {
    return desktopProxyAgent ?? undefined
  }

  const proxyEnv = await resolveDesktopProxyEnv()
  if (Object.keys(proxyEnv).length === 0) {
    desktopProxyAgent = null
    return undefined
  }

  const resolvedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...proxyEnv,
  }
  // eslint-disable-next-line import/no-extraneous-dependencies -- Desktop transport honors proxy environment variables when present
  const [{ ProxyAgent }, { getProxyForUrl }] = await Promise.all([
    import('proxy-agent'),
    import('proxy-from-env'),
  ])
  desktopProxyAgent = new ProxyAgent({
    getProxyForUrl: (url) =>
      withProcessEnv(resolvedEnv, () => getProxyForUrl(url)),
  })
  return desktopProxyAgent
}

const loadNodeFetch = async (): Promise<typeof fetch> => {
  if (!nodeFetchPromise) {
    // eslint-disable-next-line import/no-extraneous-dependencies -- Desktop transport loads node-fetch explicitly at runtime
    nodeFetchPromise = import('node-fetch/lib/index.js').then(
      (module) =>
        ((module as unknown as { default?: typeof fetch }).default ??
          module) as unknown as typeof fetch,
    )
  }

  return nodeFetchPromise
}

export const createDesktopNodeFetch = (
  options: DesktopNodeFetchOptions = {},
): typeof fetch => {
  return async (input, init) => {
    if (!Platform.isDesktop) {
      throw new Error(
        'Node request transport is only available on desktop Obsidian.',
      )
    }

    const nodeFetch = await loadNodeFetch()
    const defaultAgent = options.agent ?? (await getDesktopProxyAgent())
    const baseInit = init as NodeFetchRequestInit | undefined
    const requestInit: NodeFetchRequestInit | undefined = init
      ? {
          ...init,
          agent: baseInit?.agent ?? defaultAgent,
        }
      : defaultAgent
        ? { agent: defaultAgent }
        : undefined

    return nodeFetch(input, requestInit)
  }
}

export const createSdkFetchForTransportMode = (
  mode: RequestTransportMode,
): typeof fetch | undefined => {
  if (mode === 'obsidian') {
    return createObsidianFetch()
  }

  if (mode === 'node') {
    return createDesktopNodeFetch()
  }

  return undefined
}
