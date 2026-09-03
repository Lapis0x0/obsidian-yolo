import type {
  McpDiscoveredCatalog,
  McpServerConfig,
} from '../../types/mcp.types'

import { buildDeferredToolCatalog } from './tool-catalog'

const server = (id: string, enabled = true): McpServerConfig => ({
  id,
  parameters: { transport: 'http', url: `https://example.test/${id}` },
  enabled,
  toolOptions: {},
})

const catalog = (
  toolNames: string[],
  serverInfo?: McpDiscoveredCatalog['serverInfo'],
): McpDiscoveredCatalog => ({
  toolNames,
  ...(serverInfo ? { serverInfo } : {}),
})

const buildAll = (args: {
  configuredServers: McpServerConfig[]
  discoveredCatalogs: Record<string, McpDiscoveredCatalog>
}) => buildDeferredToolCatalog({ ...args, isDeferredAndEnabled: () => true })

describe('buildDeferredToolCatalog', () => {
  it('returns null when nothing is deferred', () => {
    expect(
      buildAll({ configuredServers: [], discoveredCatalogs: {} }),
    ).toBeNull()
  })

  it('lists fully-qualified names grouped under the server, with no per-tool descriptions', () => {
    const result = buildAll({
      configuredServers: [server('notion')],
      discoveredCatalogs: {
        notion: catalog(['notion-search', 'notion-fetch']),
      },
    })
    expect(result?.text).toContain('notion__notion-fetch')
    expect(result?.text).toContain('notion__notion-search')
    expect(result?.toolNames).toEqual([
      'notion__notion-fetch',
      'notion__notion-search',
    ])
  })

  it('prefers the server-reported title over the user-chosen local id', () => {
    const result = buildAll({
      configuredServers: [server('cf')],
      discoveredCatalogs: {
        cf: catalog(['search_docs'], {
          name: 'cloudflare-docs',
          title: 'Cloudflare Docs',
          description: 'Search and read Cloudflare documentation',
        }),
      },
    })
    expect(result?.text).toContain(
      'Cloudflare Docs — Search and read Cloudflare documentation',
    )
    // The opaque local id still forms the callable name.
    expect(result?.text).toContain('cf__search_docs')
  })

  it('falls back title -> name -> local id', () => {
    const withName = buildAll({
      configuredServers: [server('ca')],
      discoveredCatalogs: { ca: catalog(['x'], { name: 'canva' }) },
    })
    expect(withName?.text).toContain('canva')

    const bare = buildAll({
      configuredServers: [server('playright')],
      discoveredCatalogs: { playright: catalog(['x']) },
    })
    expect(bare?.text).toContain('playright')
  })

  it('keeps enabled-but-offline servers listed, since the catalog is built from configuration', () => {
    // No connection state is passed in at all — that is the invariant.
    const result = buildAll({
      configuredServers: [server('offline')],
      discoveredCatalogs: { offline: catalog(['do_thing']) },
    })
    expect(result?.toolNames).toEqual(['offline__do_thing'])
  })

  it('drops disabled servers and servers with no discovery yet', () => {
    const result = buildAll({
      configuredServers: [server('off', false), server('never-connected')],
      discoveredCatalogs: { off: catalog(['a']) },
    })
    expect(result).toBeNull()
  })

  it('omits tools the agent has not enabled or that are not deferred', () => {
    const result = buildDeferredToolCatalog({
      configuredServers: [server('notion')],
      discoveredCatalogs: {
        notion: catalog(['allowed', 'blocked']),
      },
      isDeferredAndEnabled: (name) => name.endsWith('allowed'),
    })
    expect(result?.toolNames).toEqual(['notion__allowed'])
  })

  it('names both protocol tools so the model knows the two-step path', () => {
    const result = buildAll({
      configuredServers: [server('s')],
      discoveredCatalogs: { s: catalog(['t']) },
    })
    expect(result?.text).toContain('yolo_local__load_tool_schemas')
    expect(result?.text).toContain('yolo_local__invoke_tool')
  })
})
