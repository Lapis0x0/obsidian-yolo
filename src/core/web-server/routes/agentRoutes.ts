import { createObsidianRuntimeAgent } from '../../../runtime/obsidian/obsidianRuntimeAgent'
import type { WebServerContext } from '../WebServerContext'

export function registerAgentRoutes(ctx: WebServerContext): void {
  ctx.server.router.post('/api/agent/run', async (req, res) => {
    try {
      const input = await ctx.server.readJson(req)
      const agent = createObsidianRuntimeAgent(ctx.plugin)
      await agent.run(input as any)
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/agent/abort/:conversationId', async (_req, res, params) => {
    try {
      const agent = createObsidianRuntimeAgent(ctx.plugin)
      await agent.abort(params.conversationId)
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/agent/approve-tool-call', async (req, res) => {
    try {
      const input = await ctx.server.readJson(req)
      const agent = createObsidianRuntimeAgent(ctx.plugin)
      const result = await agent.approveToolCall(input as any)
      ctx.server.json(res, 200, { ok: result })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/agent/reject-tool-call', async (req, res) => {
    try {
      const input = await ctx.server.readJson(req)
      const agent = createObsidianRuntimeAgent(ctx.plugin)
      agent.rejectToolCall(input as any)
      ctx.server.json(res, 200, { ok: true })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.post('/api/agent/abort-tool-call', async (req, res) => {
    try {
      const input = await ctx.server.readJson(req)
      const agent = createObsidianRuntimeAgent(ctx.plugin)
      const result = agent.abortToolCall(input as any)
      ctx.server.json(res, 200, { ok: result })
    } catch (error) {
      ctx.server.json(res, 500, { error: String(error) })
    }
  })

  ctx.server.router.get('/api/agent/stream/:conversationId', (req, res, params) => {
    const agent = createObsidianRuntimeAgent(ctx.plugin)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    const unsubscribe = agent.subscribe(params.conversationId, (state) => {
      const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`
      try {
        res.write(payload)
      } catch {
        unsubscribe()
      }
    })

    req.on('close', () => {
      unsubscribe()
    })
  })
}
