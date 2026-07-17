import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { App } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import { loadDesktopNodeModule } from '../../utils/platform/desktopNodeModule'

import { DesktopLocalMcpServer } from './desktopLocalMcpServer'

jest.mock('../../constants/bakedVersion', () => ({
  BAKED_PLUGIN_VERSION: 'test',
}))
jest.mock('../../utils/platform/desktopNodeModule', () => ({
  loadDesktopNodeModule: async (specifier: string) =>
    jest.requireActual(specifier) as unknown,
}))

const TOKEN = 'integration-test-token'

const getAvailablePort = async (): Promise<number> => {
  const { createServer } =
    await loadDesktopNodeModule<typeof import('node:http')>('node:http')
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const createApp = (): App => {
  const files = new Map<string, string>()
  const folders = new Set<string>()
  return {
    vault: {
      adapter: {
        exists: async (path: string) => files.has(path) || folders.has(path),
        mkdir: async (path: string) => {
          folders.add(path)
        },
        read: async (path: string) => {
          const content = files.get(path)
          if (content === undefined) throw new Error(`Missing file: ${path}`)
          return content
        },
        write: async (path: string, content: string) => {
          files.set(path, content)
        },
      },
    },
  } as unknown as App
}

describe('DesktopLocalMcpServer', () => {
  it('logs server startup failures', async () => {
    const { createServer } =
      await loadDesktopNodeModule<typeof import('node:http')>('node:http')
    const blocker = createServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', resolve)
    })
    const address = blocker.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const settings = {
      yolo: { baseDir: 'YOLO' },
      mcp: {
        localServer: { enabled: true, port, token: TOKEN },
      },
      assistants: [],
    } as unknown as YoloSettings
    const unavailable = async (): Promise<never> => {
      throw new Error('Not used by this test')
    }
    const server = new DesktopLocalMcpServer({
      app: createApp(),
      getSettings: () => settings,
      getAgentService: unavailable,
      getMcpManager: unavailable,
      getRagEngine: unavailable,
      openConversation: async () => undefined,
    })
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation()

    try {
      await server.initialize()
      await server.updateSettings(settings)

      expect(server.getState()).toMatchObject({
        status: 'error',
        error: expect.stringContaining('EADDRINUSE'),
      })
      expect(consoleSpy).toHaveBeenCalledWith(
        '[YOLO] Failed to start local MCP server',
        expect.objectContaining({
          message: expect.stringContaining('EADDRINUSE'),
        }),
      )
    } finally {
      consoleSpy.mockRestore()
      await server.close()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('authenticates an official MCP client and lists the YOLO tools', async () => {
    const port = await getAvailablePort()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      mcp: {
        localServer: { enabled: true, port, token: TOKEN },
      },
      assistants: [
        {
          id: 'research-agent',
          name: 'Research Agent',
          description: 'Searches and summarizes notes.',
        },
      ],
      currentAssistantId: 'research-agent',
    } as YoloSettings
    const unavailable = async (): Promise<never> => {
      throw new Error('Not used by this test')
    }
    const server = new DesktopLocalMcpServer({
      app: createApp(),
      getSettings: () => settings,
      getAgentService: unavailable,
      getMcpManager: unavailable,
      getRagEngine: unavailable,
      openConversation: async () => undefined,
    })
    const url = new URL(`http://127.0.0.1:${port}/mcp`)
    let client: Client | null = null

    try {
      await server.initialize()
      await server.updateSettings(settings)
      const unauthorized = await globalThis.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'unauthorized-test', version: '1.0.0' },
          },
        }),
      })
      expect(unauthorized.status).toBe(401)

      client = new Client({ name: 'yolo-test-client', version: '1.0.0' })
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: {
            headers: { Authorization: `Bearer ${TOKEN}` },
          },
        }),
      )
      const tools = await client.listTools()

      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'vault_search',
        'agent_task_start',
        'agent_task_get',
        'agent_task_cancel',
      ])
      expect(
        tools.tools.find((tool) => tool.name === 'agent_task_start')
          ?.description,
      ).toContain('research-agent: Research Agent')
    } finally {
      await client?.close().catch(() => undefined)
      await server.close()
    }
  })
})
