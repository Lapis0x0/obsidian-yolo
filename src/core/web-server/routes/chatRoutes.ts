import { createObsidianRuntimeChat } from '../../../runtime/obsidian/obsidianRuntimeChat'
import type { WebServerContext } from '../WebServerContext'

export function registerChatRoutes(ctx: WebServerContext): void {
  const chat = createObsidianRuntimeChat(ctx.plugin)

  ctx.server.router.get('/api/chat/list', async (_req, res) => {
    try {
      const list = await chat.list()
      ctx.server.json(res, 200, list)
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.get('/api/chat/get/:id', async (_req, res, params) => {
    try {
      const record = await chat.get(params.id)
      if (!record) {
        ctx.server.json(res, 404, { error: 'Conversation not found' })
        return
      }
      ctx.server.json(res, 200, record)
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/chat/save', async (req, res) => {
    try {
      const input = await ctx.server.readJson(req)
      await chat.save(input as any)
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/chat/delete', async (req, res) => {
    try {
      const { id } = (await ctx.server.readJson(req)) as { id: string }
      await chat.delete(id)
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/chat/toggle-pinned', async (req, res) => {
    try {
      const { id } = (await ctx.server.readJson(req)) as { id: string }
      await chat.togglePinned(id)
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/chat/update-title', async (req, res) => {
    try {
      const {
        id,
        title,
        touchUpdatedAt,
      } = (await ctx.server.readJson(req)) as {
        id: string
        title: string
        touchUpdatedAt?: boolean
      }
      await chat.updateTitle(id, title, { touchUpdatedAt })
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/chat/generate-title', async (req, res) => {
    try {
      const { id, messages } = (await ctx.server.readJson(req)) as {
        id: string
        messages: unknown[]
      }
      await chat.generateTitle(id, messages as any)
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })
}
