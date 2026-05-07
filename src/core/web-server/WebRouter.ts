import { IncomingMessage, ServerResponse } from 'http'

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>

export class WebRouter {
  private routes: Array<{
    method: string
    pattern: RegExp
    paramNames: string[]
    handler: RouteHandler
  }> = []

  get(path: string, handler: RouteHandler): void {
    this.addRoute('GET', path, handler)
  }

  post(path: string, handler: RouteHandler): void {
    this.addRoute('POST', path, handler)
  }

  put(path: string, handler: RouteHandler): void {
    this.addRoute('PUT', path, handler)
  }

  delete(path: string, handler: RouteHandler): void {
    this.addRoute('DELETE', path, handler)
  }

  private addRoute(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = []
    const patternStr = path.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name)
      return '([^/]+)'
    })
    const pattern = new RegExp(`^${patternStr}$`)
    this.routes.push({ method, pattern, paramNames, handler })
  }

  resolve(method: string, url: string): { handler: RouteHandler; params: Record<string, string> } | null {
    const pathname = url.split('?')[0]
    for (const route of this.routes) {
      if (route.method !== method) continue
      const match = pathname.match(route.pattern)
      if (!match) continue
      const params: Record<string, string> = {}
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1])
      })
      return { handler: route.handler, params }
    }
    return null
  }
}
