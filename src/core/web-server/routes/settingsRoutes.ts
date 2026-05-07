import type { WebServerContext } from '../WebServerContext'

export function registerSettingsRoutes(ctx: WebServerContext): void {
  ctx.server.router.get('/api/settings', (_req, res) => {
    ctx.server.json(res, 200, ctx.plugin.settings)
  })

  ctx.server.router.post('/api/settings/update', async (req, res) => {
    try {
      const next = await ctx.server.readJson(req)
      await ctx.plugin.setSettings(next as any)
      ctx.server.json(res, 200, ctx.plugin.settings)
    } catch (error) {
      ctx.server.json(res, 400, { error: 'Invalid settings payload' })
    }
  })
}
