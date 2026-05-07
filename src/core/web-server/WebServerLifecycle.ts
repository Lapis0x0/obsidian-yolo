import { FileSystemAdapter, normalizePath } from 'obsidian'
import type SmartComposerPlugin from '../../main'
import { WebHttpServer } from './WebHttpServer'
import type { WebServerContext } from './WebServerContext'
import { registerBootstrapRoutes } from './routes/bootstrapRoutes'
import { registerSettingsRoutes } from './routes/settingsRoutes'
import { registerChatRoutes } from './routes/chatRoutes'
import { registerAgentRoutes } from './routes/agentRoutes'
import { registerVaultRoutes } from './routes/vaultRoutes'

type WebStaticAssetConfig = {
  webUiDir?: string
  staticFileOverrides?: Record<string, string>
}

export const DEFAULT_WEB_RUNTIME_SERVER_PORT = 18789
export const DEFAULT_WEB_RUNTIME_SERVER_HOST = '127.0.0.1'

export class WebServerLifecycle {
  private server: WebHttpServer | null = null

  constructor(private readonly plugin: SmartComposerPlugin) {}

  private resolveStaticAssetConfig(): WebStaticAssetConfig {
    const pluginDir = this.plugin.manifest.dir
    if (!pluginDir) {
      return {}
    }

    const adapter = this.plugin.app.vault.adapter
    if (!(adapter instanceof FileSystemAdapter)) {
      return {}
    }

    const pluginRootDir = normalizePath(
      `${adapter.getBasePath()}/${pluginDir}`,
    )

    return {
      webUiDir: normalizePath(`${pluginRootDir}/web-ui`),
      staticFileOverrides: {},
    }
  }

  async start(): Promise<number | null> {
    const settings = this.plugin.settings
    const webConfig = settings.webRuntimeServer
    if (!webConfig?.enabled) return null

    const staticAssets = webConfig.serveStatic
      ? this.resolveStaticAssetConfig()
      : {}

    this.server = new WebHttpServer({
      host: webConfig.host || DEFAULT_WEB_RUNTIME_SERVER_HOST,
      port: webConfig.port || DEFAULT_WEB_RUNTIME_SERVER_PORT,
      webUiDir: staticAssets.webUiDir,
      staticFileOverrides: staticAssets.staticFileOverrides,
      token: webConfig.token || '',
    })

    const ctx: WebServerContext = {
      plugin: this.plugin,
      server: this.server,
    }

    registerBootstrapRoutes(ctx)
    registerSettingsRoutes(ctx)
    registerChatRoutes(ctx)
    registerAgentRoutes(ctx)
    registerVaultRoutes(ctx)

    const port = await this.server.start()
    return port
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await this.server.stop()
    this.server = null
  }

  isRunning(): boolean {
    return this.server !== null
  }

  getPort(): number | null {
    return this.server ? (this.server as any).config?.port ?? null : null
  }
}
