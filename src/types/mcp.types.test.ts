import {
  getMcpServerNamesFromInput,
  mcpServerParametersSchema,
  normalizeMcpServerParameters,
} from './mcp.types'

describe('normalizeMcpServerParameters', () => {
  it('normalizes legacy stdio format', () => {
    const result = normalizeMcpServerParameters({
      value: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
      },
    })

    expect(result).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    })
  })

  it('supports canonical http format', () => {
    const result = normalizeMcpServerParameters({
      value: {
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: {
          Authorization: 'Bearer token',
        },
      },
    })

    expect(result).toEqual({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: {
        Authorization: 'Bearer token',
      },
    })
  })

  it('normalizes streamable-http type aliases from third-party MCP configs', () => {
    const result = normalizeMcpServerParameters({
      value: {
        mcpServers: {
          机器人消息: {
            type: 'streamable-http',
            url: 'https://mcp-gw.dingtalk.com/server/demo?key=token',
          },
        },
      },
      serverName: 'dingtalk',
    })

    expect(result).toEqual({
      transport: 'http',
      url: 'https://mcp-gw.dingtalk.com/server/demo?key=token',
    })
  })

  it('extracts parameters from mcpServers wrapper by server name', () => {
    const result = normalizeMcpServerParameters({
      value: {
        mcpServers: {
          github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
          },
          browser: {
            transport: 'http',
            url: 'https://example.com/mcp',
          },
        },
      },
      serverName: 'browser',
    })

    expect(result).toEqual({
      transport: 'http',
      url: 'https://example.com/mcp',
    })
  })

  it('extracts single entry from mcpServers wrapper', () => {
    const result = normalizeMcpServerParameters({
      value: {
        mcpServers: {
          github: {
            parameters: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-github'],
            },
          },
        },
      },
    })

    expect(result).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    })
  })

  it('throws when multiple wrapped servers are provided without name', () => {
    expect(() =>
      normalizeMcpServerParameters({
        value: {
          mcpServers: {
            a: { command: 'npx' },
            b: { command: 'node' },
          },
        },
      }),
    ).toThrow('Multiple servers found in "mcpServers"')
  })

  it('falls back to single wrapped server when provided name mismatches', () => {
    const result = normalizeMcpServerParameters({
      value: {
        mcpServers: {
          'baidu-map': {
            command: 'npx',
            args: ['-y', '@baidumap/mcp-server-baidu-map'],
          },
        },
      },
      serverName: 'test',
    })

    expect(result).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@baidumap/mcp-server-baidu-map'],
    })
  })

  it('extracts wrapped server names', () => {
    const names = getMcpServerNamesFromInput({
      mcpServers: {
        github: { command: 'npx' },
        browser: { transport: 'http', url: 'https://example.com/mcp' },
      },
    })

    expect(names).toEqual(['github', 'browser'])
  })

  it('validates URL protocol by transport', () => {
    expect(() =>
      mcpServerParametersSchema.parse({
        transport: 'ws',
        url: 'https://example.com/mcp',
      }),
    ).toThrow()
  })
})
