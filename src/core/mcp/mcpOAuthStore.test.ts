import { App } from 'obsidian'

import { McpOAuthStore } from './mcpOAuthStore'

const createApp = () => {
  const configDir = '.test-config'
  const files = new Map<string, string>()
  const directories = new Set<string>()
  const adapter = {
    exists: jest.fn(
      async (path: string) => files.has(path) || directories.has(path),
    ),
    mkdir: jest.fn(async (path: string) => {
      directories.add(path)
    }),
    read: jest.fn(async (path: string) => files.get(path) ?? ''),
    write: jest.fn(async (path: string, value: string) => {
      files.set(path, value)
    }),
    remove: jest.fn(async (path: string) => {
      files.delete(path)
    }),
  }
  return {
    app: {
      vault: { configDir, adapter },
    } as unknown as App,
    files,
    adapter,
  }
}

describe('McpOAuthStore', () => {
  it('stores credentials outside data.json and binds them to the server URL', async () => {
    const { app, files } = createApp()
    const store = new McpOAuthStore(app, 'yolo')
    const credential = {
      version: 1 as const,
      serverUrl: 'https://example.com/mcp',
      tokens: {
        access_token: 'access-token',
        token_type: 'Bearer',
      },
    }

    await store.set('example/server', credential)

    expect(Array.from(files.keys())).toEqual([
      '.test-config/plugins/yolo/mcp-oauth/example%2Fserver.json',
    ])
    await expect(
      store.get('example/server', 'https://example.com/mcp'),
    ).resolves.toEqual(credential)
    await expect(
      store.get('example/server', 'https://other.example.com/mcp'),
    ).resolves.toBeNull()
  })

  it('clears a stored credential', async () => {
    const { app, files } = createApp()
    const store = new McpOAuthStore(app, 'yolo')
    await store.set('example', {
      version: 1,
      serverUrl: 'https://example.com/mcp',
    })

    await store.clear('example')

    expect(files.size).toBe(0)
  })
})
