import { shouldBypassProxy } from '../../../utils/net/proxyBypass'
import { resolveSystemProxy } from '../../../utils/net/systemProxyResolver'

type ProxyChainServer = import('proxy-chain').Server
type PrepareRequestFunction = import('proxy-chain').PrepareRequestFunction
type PrepareRequestFunctionOpts =
  import('proxy-chain').PrepareRequestFunctionOpts

let bridgePromise: Promise<ProxyChainServer> | null = null
let bridgeAcceptingStarts = true

const formatUrlHost = (hostname: string): string =>
  hostname.includes(':') && !hostname.startsWith('[')
    ? `[${hostname}]`
    : hostname

const buildTargetUrl = ({
  request,
  hostname,
  port,
  isHttp,
}: PrepareRequestFunctionOpts): string => {
  if (isHttp && request.url) {
    try {
      const url = new URL(request.url)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.href
      }
    } catch {
      // Fall back to the normalized target fields from proxy-chain.
    }
  }

  const protocol = isHttp ? 'http' : 'https'
  return `${protocol}://${formatUrlHost(hostname)}:${port}`
}

const prepareSystemProxyRequest: PrepareRequestFunction = async (options) => {
  const targetUrl = buildTargetUrl(options)
  const upstreamProxyUrl = shouldBypassProxy(targetUrl)
    ? ''
    : await resolveSystemProxy(targetUrl)

  return {
    upstreamProxyUrl: upstreamProxyUrl || null,
  }
}

const startSystemProxyBridge = async (): Promise<ProxyChainServer> => {
  const { Server } = await import('proxy-chain')
  const server = new Server({
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: prepareSystemProxyRequest,
  })
  await server.listen()
  return server
}

export const getSystemProxyBridgeUrl = async (): Promise<string | null> => {
  if (!bridgeAcceptingStarts) return null

  if (!bridgePromise) {
    bridgePromise = startSystemProxyBridge()
  }
  const pendingBridge = bridgePromise

  try {
    const server = await pendingBridge
    if (!bridgeAcceptingStarts) return null
    return `http://127.0.0.1:${server.port}`
  } catch (error) {
    if (bridgePromise === pendingBridge) {
      bridgePromise = null
    }
    console.warn('[YOLO] Failed to start the system proxy bridge.', error)
    return null
  }
}

export const stopSystemProxyBridge = async (): Promise<void> => {
  bridgeAcceptingStarts = false
  const pendingBridge = bridgePromise
  bridgePromise = null
  if (!pendingBridge) return

  try {
    const server = await pendingBridge
    await server.close(true)
  } catch {
    // A bridge that failed to start has nothing to close.
  }
}

export const __test__ = {
  buildTargetUrl,
  prepareSystemProxyRequest,
}
