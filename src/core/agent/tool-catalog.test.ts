import type {
  McpDiscoveredCatalog,
  McpServerConfig,
  McpTool,
} from '../../types/mcp.types'

import {
  type ToolSetDescriptor,
  buildDeferredToolCatalog,
  describeInProcessToolSets,
  describeMcpToolSets,
} from './tool-catalog'

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

const buildAll = (toolSets: ToolSetDescriptor[]) =>
  buildDeferredToolCatalog({ toolSets, isDeferredAndEnabled: () => true })

const buildFromMcp = (args: {
  configuredServers: McpServerConfig[]
  discoveredCatalogs: Record<string, McpDiscoveredCatalog>
}) => buildAll(describeMcpToolSets(args))

describe('describeMcpToolSets', () => {
  it('prefers the server-reported title over the user-chosen local id', () => {
    const result = buildFromMcp({
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

  it('keeps the local alias when the server reports a deployment id as its name', () => {
    const result = buildFromMcp({
      configuredServers: [server('dingtalk')],
      discoveredCatalogs: {
        dingtalk: catalog(['search_my_robots'], {
          name: 'dingtalk-mcp-21b6ab2e1179b05980c39fa4e36e71f44f1b8c98b6f541ed3697c8',
        }),
      },
    })
    expect(result?.text).toContain('dingtalk\n')
    expect(result?.text).not.toContain('21b6ab2e')
  })

  it('falls back title -> name -> local id', () => {
    const withName = buildFromMcp({
      configuredServers: [server('ca')],
      discoveredCatalogs: { ca: catalog(['x'], { name: 'canva' }) },
    })
    expect(withName?.text).toContain('canva')

    const bare = buildFromMcp({
      configuredServers: [server('playright')],
      discoveredCatalogs: { playright: catalog(['x']) },
    })
    expect(bare?.text).toContain('playright')
  })

  it('keeps enabled-but-offline servers listed, since the catalog is built from configuration', () => {
    // No connection state is passed in at all — that is the invariant.
    const result = buildFromMcp({
      configuredServers: [server('offline')],
      discoveredCatalogs: { offline: catalog(['do_thing']) },
    })
    expect(result?.toolNames).toEqual(['offline__do_thing'])
  })

  it('drops disabled servers and servers with no discovery yet', () => {
    const result = buildFromMcp({
      configuredServers: [server('off', false), server('never-connected')],
      discoveredCatalogs: { off: catalog(['a']) },
    })
    expect(result).toBeNull()
  })
})

describe('describeInProcessToolSets', () => {
  const tool = (name: string): McpTool => ({
    name,
    inputSchema: { type: 'object' },
  })

  it('groups module tools by their server prefix without needing persisted discovery', () => {
    const sets = describeInProcessToolSets({
      availableTools: [
        tool('whiteboard__add_card'),
        tool('whiteboard__layout'),
      ],
      configuredServerIds: new Set(),
    })
    expect(sets).toEqual([
      {
        id: 'whiteboard',
        label: 'whiteboard',
        toolNames: ['add_card', 'layout'],
      },
    ])
  })

  it('skips built-in local tools and anything an MCP server already describes', () => {
    const sets = describeInProcessToolSets({
      availableTools: [
        tool('yolo_local__read_file'),
        tool('notion__notion-search'),
        tool('whiteboard__add_card'),
      ],
      configuredServerIds: new Set(['notion']),
    })
    expect(sets.map((set) => set.id)).toEqual(['whiteboard'])
  })
})

describe('buildDeferredToolCatalog', () => {
  it('returns null when nothing is deferred', () => {
    expect(buildAll([])).toBeNull()
  })

  it('lists fully-qualified names grouped under the set, with no per-tool descriptions', () => {
    const result = buildFromMcp({
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

  it('lists MCP and in-process sets side by side, in one stable order', () => {
    const result = buildAll([
      ...describeMcpToolSets({
        configuredServers: [server('notion')],
        discoveredCatalogs: { notion: catalog(['notion-search']) },
      }),
      ...describeInProcessToolSets({
        availableTools: [
          { name: 'whiteboard__add_card', inputSchema: { type: 'object' } },
        ],
        configuredServerIds: new Set(['notion']),
      }),
    ])
    expect(result?.toolNames).toEqual([
      'notion__notion-search',
      'whiteboard__add_card',
    ])
  })

  it('omits tools the agent has not enabled or that are not deferred', () => {
    const result = buildDeferredToolCatalog({
      toolSets: describeMcpToolSets({
        configuredServers: [server('notion')],
        discoveredCatalogs: { notion: catalog(['allowed', 'blocked']) },
      }),
      isDeferredAndEnabled: (name) => name.endsWith('allowed'),
    })
    expect(result?.toolNames).toEqual(['notion__allowed'])
  })

  it('names both protocol tools so the model knows the two-step path', () => {
    const result = buildFromMcp({
      configuredServers: [server('s')],
      discoveredCatalogs: { s: catalog(['t']) },
    })
    // Built-ins reach the model under their short names (`toModelToolName`);
    // the catalog's own entries keep their server prefix.
    expect(result?.text).toContain('`load_tool_schemas`')
    expect(result?.text).toContain('`invoke_tool`')
    expect(result?.text).not.toContain('yolo_local__')
    expect(result?.text).toContain('s__t')
  })
})
