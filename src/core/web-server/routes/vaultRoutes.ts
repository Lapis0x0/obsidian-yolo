import { createObsidianRuntimeVault } from '../../../runtime/obsidian/obsidianRuntimeVault'
import type { WebServerContext } from '../WebServerContext'

export function registerVaultRoutes(ctx: WebServerContext): void {
  ctx.server.router.get('/api/vault/index', async (_req, res) => {
    try {
      const vault = createObsidianRuntimeVault(ctx.plugin.app)
      const index = await vault.listIndex?.()
      ctx.server.json(res, 200, index ?? [])
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.get('/api/vault/active-file', (_req, res) => {
    const vault = createObsidianRuntimeVault(ctx.plugin.app)
    const file = vault.getActiveFile()
    ctx.server.json(res, 200, file)
  })

  ctx.server.router.get('/api/vault/read', async (req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const path = url.searchParams.get('path')
    if (!path) {
      ctx.server.json(res, 400, { error: 'Missing path query param' })
      return
    }
    try {
      const vault = createObsidianRuntimeVault(ctx.plugin.app)
      const content = await vault.read(path)
      ctx.server.json(res, 200, { content })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.get('/api/vault/read-binary', async (req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const path = url.searchParams.get('path')
    if (!path) {
      ctx.server.json(res, 400, { error: 'Missing path query param' })
      return
    }
    try {
      const file = ctx.plugin.app.vault.getFileByPath(path)
      if (!file) {
        ctx.server.json(res, 404, { error: 'File not found' })
        return
      }
      const vault = createObsidianRuntimeVault(ctx.plugin.app)
      const bytes = await vault.readBinary?.(file)
      if (!bytes) {
        ctx.server.json(res, 500, { error: 'Binary read not available' })
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': Buffer.byteLength(Buffer.from(bytes)),
      })
      res.end(Buffer.from(bytes))
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.get('/api/vault/list', async (req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const path = url.searchParams.get('path')
    if (!path) {
      ctx.server.json(res, 400, { error: 'Missing path query param' })
      return
    }
    try {
      const listing = await ctx.plugin.app.vault.adapter.list(path)
      ctx.server.json(res, 200, listing)
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.get('/api/vault/stat', async (req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const path = url.searchParams.get('path')
    if (!path) {
      ctx.server.json(res, 400, { error: 'Missing path query param' })
      return
    }
    try {
      const stat = await ctx.plugin.app.vault.adapter.stat(path)
      if (!stat) {
        ctx.server.json(res, 404, { error: 'Path not found' })
        return
      }
      ctx.server.json(res, 200, stat)
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.get('/api/vault/search', async (req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const query = url.searchParams.get('query')
    if (!query) {
      ctx.server.json(res, 400, { error: 'Missing query param' })
      return
    }
    try {
      const vault = createObsidianRuntimeVault(ctx.plugin.app)
      const results = await vault.search(query)
      ctx.server.json(res, 200, results)
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/vault/modify', async (req, res) => {
    try {
      const { path, content } = (await ctx.server.readJson(req)) as { path: string; content: string }
      const vault = createObsidianRuntimeVault(ctx.plugin.app)
      await vault.modify(path, content)
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/vault/write', async (req, res) => {
    try {
      const { path, content } = (await ctx.server.readJson(req)) as {
        path: string
        content: string
      }
      await ctx.plugin.app.vault.adapter.write(path, content)
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/vault/write-binary', async (req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const path = url.searchParams.get('path')
    if (!path) {
      ctx.server.json(res, 400, { error: 'Missing path query param' })
      return
    }
    try {
      const content = await ctx.server.readBuffer(req)
      await ctx.plugin.app.vault.adapter.writeBinary(
        path,
        content.buffer.slice(
          content.byteOffset,
          content.byteOffset + content.byteLength,
        ),
      )
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/vault/create', async (req, res) => {
    try {
      const { path, content } = (await ctx.server.readJson(req)) as { path: string; content: string }
      const vault = createObsidianRuntimeVault(ctx.plugin.app)
      await vault.create(path, content)
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/vault/create-folder', async (req, res) => {
    try {
      const { path } = (await ctx.server.readJson(req)) as { path: string }
      const vault = createObsidianRuntimeVault(ctx.plugin.app)
      await vault.createFolder(path)
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/vault/trash-file', async (req, res) => {
    try {
      const { path } = (await ctx.server.readJson(req)) as { path: string }
      const vault = createObsidianRuntimeVault(ctx.plugin.app)
      await vault.trashFile(path)
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/vault/remove', async (req, res) => {
    try {
      const { path } = (await ctx.server.readJson(req)) as { path: string }
      await ctx.plugin.app.vault.adapter.remove(path)
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/vault/rmdir', async (req, res) => {
    try {
      const { path, recursive } = (await ctx.server.readJson(req)) as {
        path: string
        recursive?: boolean
      }
      await ctx.plugin.app.vault.adapter.rmdir(path, Boolean(recursive))
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })
}
