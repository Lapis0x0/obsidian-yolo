import { App } from 'obsidian'

import { McpOAuthController } from './mcpOAuthController'

jest.mock('../../utils/platform/desktopNodeModule', () => ({
  loadDesktopNodeModule: jest.fn(async () => jest.requireActual('node:http')),
}))

const createApp = () => {
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
      vault: { configDir: '.test-config', adapter },
    } as unknown as App,
    files,
  }
}

describe('McpOAuthController', () => {
  it('commits a completed draft and rolls it back when settings fail', async () => {
    const { app, files } = createApp()
    const controller = new McpOAuthController(app, 'yolo')

    try {
      const provider = await controller.createDraftProvider(
        'draft-1',
        'https://example.com/mcp',
      )
      await provider.saveTokens({
        access_token: 'access-token',
        token_type: 'Bearer',
      })

      const rollback = await controller.commitDraft('draft-1', 'example')
      expect(files.size).toBe(1)
      await rollback()
      expect(files.size).toBe(0)
    } finally {
      controller.close()
    }
  })

  it('never persists a discarded draft', async () => {
    const { app, files } = createApp()
    const controller = new McpOAuthController(app, 'yolo')

    try {
      const provider = await controller.createDraftProvider(
        'draft-2',
        'https://example.com/mcp',
      )
      await provider.saveTokens({
        access_token: 'access-token',
        token_type: 'Bearer',
      })
      controller.discardDraft('draft-2')

      expect(files.size).toBe(0)
      await expect(
        controller.commitDraft('draft-2', 'example'),
      ).rejects.toThrow('Complete OAuth authorization')
    } finally {
      controller.close()
    }
  })
})
