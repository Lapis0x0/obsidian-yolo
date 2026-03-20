/**
 * A streaming-capable fetch implementation using Node.js http/https modules.
 *
 * Obsidian's `requestUrl` buffers the entire response before returning,
 * which breaks Server-Sent Events (SSE) transports that require reading
 * the response body as a stream. This implementation uses Node's native
 * http/https modules to return a proper streaming Response compatible
 * with the `eventsource` package and MCP SDK transports.
 *
 * Proxy support: uses `proxy-agent` to automatically read HTTP_PROXY /
 * HTTPS_PROXY / NO_PROXY from process.env and select the correct proxy
 * mechanism (forward proxy for HTTP, CONNECT tunnel for HTTPS, SOCKS)
 * based on the target URL protocol.
 */

import type * as http from 'node:http'
import type * as https from 'node:https'

import { ProxyAgent } from 'proxy-agent'

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

// Shared proxy agent instance — automatically resolves proxy from env vars
// (HTTP_PROXY, HTTPS_PROXY, NO_PROXY) and selects the appropriate mechanism
// (forward proxy for http://, CONNECT tunnel for https://, SOCKS, or direct).
const proxyAgent = new ProxyAgent()

export const createNodeStreamingFetch = (): FetchLike => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const httpModule = require('http') as typeof http
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const httpsModule = require('https') as typeof https

  return (url: string | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = url instanceof URL ? url.toString() : url
    const parsedUrl = new URL(urlStr)
    const isHttps = parsedUrl.protocol === 'https:'
    const mod = isHttps ? httpsModule : httpModule

    return new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string> = {}
      if (init?.headers) {
        const h = new Headers(init.headers)
        h.forEach((value, key) => {
          headers[key] = value
        })
      }

      const options: http.RequestOptions = {
        method: init?.method ?? 'GET',
        headers,
        agent: proxyAgent,
      }

      const req = mod.request(urlStr, options, (res) => {
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(res.headers)) {
          if (value != null) {
            responseHeaders.set(
              key,
              Array.isArray(value) ? value.join(', ') : value,
            )
          }
        }

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on('data', (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk))
            })
            res.on('end', () => {
              controller.close()
            })
            res.on('error', (err) => {
              controller.error(err)
            })
          },
          cancel() {
            res.destroy()
          },
        })

        resolve(
          new Response(stream, {
            status: res.statusCode ?? 200,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
          }),
        )
      })

      req.on('error', reject)

      if (init?.signal) {
        if (init.signal.aborted) {
          req.destroy()
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        init.signal.addEventListener('abort', () => {
          req.destroy()
        })
      }

      if (init?.body != null) {
        if (typeof init.body === 'string') {
          req.write(init.body)
        } else if (init.body instanceof ArrayBuffer) {
          req.write(Buffer.from(init.body))
        } else if (ArrayBuffer.isView(init.body)) {
          req.write(
            Buffer.from(
              init.body.buffer,
              init.body.byteOffset,
              init.body.byteLength,
            ),
          )
        } else if (init.body instanceof Blob) {
          init.body.arrayBuffer().then(
            (buf) => {
              req.write(Buffer.from(buf))
              req.end()
            },
            (err) => {
              req.destroy(err)
              reject(err)
            },
          )
          return
        }
      }

      req.end()
    })
  }
}
