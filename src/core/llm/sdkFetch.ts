import { Platform } from 'obsidian'

import type { RequestTransportMode } from '../../types/provider.types'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { shouldBypassProxy } from '../../utils/net/proxyBypass'
import { resolveSystemProxy } from '../../utils/net/systemProxyResolver'
import { loadDesktopNodeModule } from '../../utils/platform/desktopNodeModule'

import { createLLMDebugFetch } from './debugCapture'
import type {
  UploadProgressCallback,
  UploadProgressFetch,
  UploadProgressRequestInit,
} from './fetchTypes'

type RequestOptions = import('node:http').RequestOptions
type NodeReadable = import('node:stream').Readable

let nodeFetchPromise: Promise<typeof fetch> | null = null
let desktopProxyAgent: RequestOptions['agent'] | null | undefined

type NodeFetchRequestInit = RequestInit & {
  agent?: RequestOptions['agent']
}

export type DesktopNodeFetchOptions = {
  agent?: RequestOptions['agent']
}

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
const UPLOAD_PROGRESS_CHUNK_BYTES = 256 * 1024

const envHasProxy = (env: NodeJS.ProcessEnv): boolean =>
  PROXY_ENV_KEYS.some((key) => typeof env[key] === 'string' && env[key]?.trim())

const getDesktopProxyAgent = async (): Promise<
  RequestOptions['agent'] | undefined
> => {
  if (desktopProxyAgent !== undefined) {
    return desktopProxyAgent ?? undefined
  }

  const [{ ProxyAgent }, { getProxyForUrl }] = await Promise.all([
    import('proxy-agent'),
    import('proxy-from-env'),
  ])

  // proxy-agent@6.5.0 accepts `Promise<string>` from getProxyForUrl.
  // Decision order per URL:
  //   1. Local/private destinations — always DIRECT (matches curl/VS Code).
  //   2. Explicit HTTP(S)_PROXY/NO_PROXY env — honor the user's override.
  //   3. Otherwise delegate to Chromium via @electron/remote, giving parity
  //      with Obsidian's requestUrl and globalThis.fetch on all 3 OSes.
  desktopProxyAgent = new ProxyAgent({
    getProxyForUrl: async (url: string): Promise<string> => {
      if (shouldBypassProxy(url)) return ''
      if (envHasProxy(process.env)) return getProxyForUrl(url)
      return resolveSystemProxy(url)
    },
  })
  return desktopProxyAgent
}

const loadNodeFetch = async (): Promise<typeof fetch> => {
  if (!nodeFetchPromise) {
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
  const nodeFetchWithProxy: UploadProgressFetch = async (input, init) => {
    if (!Platform.isDesktop) {
      throw new Error(
        'Node request transport is only available on desktop Obsidian.',
      )
    }

    const nodeFetch = await loadNodeFetch()
    const defaultAgent = options.agent ?? (await getDesktopProxyAgent())
    return nodeFetchWithUploadProgress(nodeFetch, input, init, defaultAgent)
  }
  return createLLMDebugFetch(nodeFetchWithProxy, 'node')
}

export const createBrowserFetch = (): typeof fetch => {
  const browserFetch: UploadProgressFetch = async (input, init) => {
    if (
      init?.onUploadProgress &&
      typeof init.body !== 'undefined' &&
      typeof XMLHttpRequest !== 'undefined'
    ) {
      return browserFetchWithUploadProgress(input, init)
    }
    const { onUploadProgress: _onUploadProgress, ...fetchInit } = init ?? {}
    return globalThis.fetch(input, fetchInit)
  }
  return createLLMDebugFetch(browserFetch, 'browser')
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

const prepareNodeRequestInit = async (
  init?: UploadProgressRequestInit,
): Promise<NodeFetchRequestInit | undefined> => {
  if (!init) return undefined
  const { onUploadProgress, body, ...rest } = init
  if (!onUploadProgress || typeof body === 'undefined' || body === null) {
    return { ...rest, body }
  }

  const buffer = await bodyToBuffer(body)
  if (!buffer) {
    // Some SDKs may pass FormData/stream bodies. Leave those untouched rather
    // than guessing a serialization format; ASR uploads use bufferable bodies.
    return { ...rest, body } as NodeFetchRequestInit
  }
  const headers = withContentLength(rest.headers, buffer.byteLength)
  return {
    ...rest,
    headers,
    body: (await createProgressReadable(
      buffer,
      onUploadProgress,
    )) as unknown as BodyInit,
  }
}

const nodeFetchWithUploadProgress = async (
  nodeFetch: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: UploadProgressRequestInit | undefined,
  defaultAgent: RequestOptions['agent'] | undefined,
): Promise<Response> => {
  const preparedInit = await prepareNodeRequestInit(init)
  const requestInit: NodeFetchRequestInit | undefined = preparedInit
    ? {
        ...preparedInit,
        agent: preparedInit.agent ?? defaultAgent,
      }
    : defaultAgent
      ? { agent: defaultAgent }
      : undefined

  return nodeFetch(input, requestInit)
}

// node-fetch has no upload progress event, so bufferable request bodies are
// sent through a Readable that reports progress as each chunk is yielded.
const createProgressReadable = async (
  buffer: Buffer,
  onUploadProgress: UploadProgressCallback,
): Promise<NodeReadable> => {
  const { Readable } =
    await loadDesktopNodeModule<typeof import('node:stream')>('node:stream')
  async function* chunks() {
    const totalBytes = buffer.byteLength
    onUploadProgress({ sentBytes: 0, totalBytes })
    for (
      let offset = 0;
      offset < totalBytes;
      offset += UPLOAD_PROGRESS_CHUNK_BYTES
    ) {
      const end = Math.min(totalBytes, offset + UPLOAD_PROGRESS_CHUNK_BYTES)
      onUploadProgress({ sentBytes: end, totalBytes })
      yield buffer.subarray(offset, end)
    }
  }
  return Readable.from(chunks())
}

const withContentLength = (
  headers: HeadersInit | undefined,
  byteLength: number,
): HeadersInit => {
  if (headers instanceof Headers) {
    const next = new Headers(headers)
    if (!next.has('content-length'))
      next.set('content-length', String(byteLength))
    return next
  }
  if (Array.isArray(headers)) {
    const hasContentLength = headers.some(
      ([key]) => key.toLowerCase() === 'content-length',
    )
    return hasContentLength
      ? headers
      : [...headers, ['content-length', String(byteLength)]]
  }
  const next: Record<string, string> = {
    ...(headers
      ? Object.fromEntries(
          Object.entries(headers).map(([key, value]) => [key, String(value)]),
        )
      : {}),
  }
  if (
    !Object.keys(next).some((key) => key.toLowerCase() === 'content-length')
  ) {
    next['content-length'] = String(byteLength)
  }
  return next
}

const browserFetchWithUploadProgress = (
  input: Parameters<typeof fetch>[0],
  init: UploadProgressRequestInit,
): Promise<Response> =>
  new Promise((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const xhr = new XMLHttpRequest()
    const url =
      typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.toString()
    const method =
      init.method ?? (input instanceof Request ? input.method : 'GET')
    const fallbackTotal = getBodyByteLength(init.body)
    let settled = false
    const cleanup = () => {
      init.signal?.removeEventListener('abort', onAbort)
    }
    const safeReject = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const safeResolve = (response: Response) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(response)
    }
    const onAbort = () => {
      xhr.abort()
      safeReject(new DOMException('Aborted', 'AbortError'))
    }

    xhr.open(method, url, true)
    xhr.responseType = 'arraybuffer'
    setXhrHeaders(xhr, init.headers)
    init.onUploadProgress?.({ sentBytes: 0, totalBytes: fallbackTotal })
    xhr.upload.onprogress = (event) => {
      init.onUploadProgress?.({
        sentBytes: event.loaded,
        totalBytes: event.lengthComputable ? event.total : fallbackTotal,
      })
    }
    xhr.onload = () => {
      const body =
        xhr.response instanceof ArrayBuffer ? xhr.response : new ArrayBuffer(0)
      safeResolve(
        new Response(body, {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: parseXhrResponseHeaders(xhr.getAllResponseHeaders()),
        }),
      )
    }
    xhr.onerror = () => safeReject(new TypeError('Failed to fetch'))
    xhr.onabort = () => safeReject(new DOMException('Aborted', 'AbortError'))
    init.signal?.addEventListener('abort', onAbort, { once: true })
    xhr.send(init.body as XMLHttpRequestBodyInit)
  })

const setXhrHeaders = (
  xhr: XMLHttpRequest,
  headers: HeadersInit | undefined,
): void => {
  if (!headers) return
  if (headers instanceof Headers) {
    headers.forEach((value, key) => xhr.setRequestHeader(key, value))
    return
  }
  if (Array.isArray(headers)) {
    headers.forEach(([key, value]) => xhr.setRequestHeader(key, String(value)))
    return
  }
  Object.entries(headers).forEach(([key, value]) =>
    xhr.setRequestHeader(key, String(value)),
  )
}

const parseXhrResponseHeaders = (raw: string): Headers => {
  const headers = new Headers()
  raw
    .trim()
    .split(/[\r\n]+/)
    .filter(Boolean)
    .forEach((line) => {
      const separator = line.indexOf(':')
      if (separator <= 0) return
      headers.append(
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim(),
      )
    })
  return headers
}

const getBodyByteLength = (body: BodyInit | null | undefined): number => {
  if (body == null) return 0
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength
  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString()).byteLength
  }
  if (body instanceof Blob) return body.size
  if (body instanceof ArrayBuffer) return body.byteLength
  if (ArrayBuffer.isView(body)) return body.byteLength
  return 0
}

const bodyToBuffer = async (body: BodyInit): Promise<Buffer | null> => {
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString(), 'utf8')
  }
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer())
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  }
  return null
}
