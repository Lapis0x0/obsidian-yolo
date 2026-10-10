import { App, normalizePath } from 'obsidian'
import path from 'path-browserify'

/**
 * Short-lived token returned by `copilot_internal/v2/token`, together with
 * the API origin the token is valid for. Always obtained in one exchange, so
 * the three fields are stored and replaced as a unit.
 */
export type CopilotSession = {
  copilotToken: string
  /** Epoch milliseconds. */
  copilotExpiresAt: number
  apiBaseUrl: string
}

export type CopilotOAuthCredential = {
  /** Long-lived GitHub OAuth token from the device flow. */
  githubToken: string
  session?: CopilotSession
  updatedAt: number
}

const CREDENTIAL_DIR_NAME = 'github-copilot-oauth'

const parseSession = (raw: unknown): CopilotSession | undefined => {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }
  const value = raw as Partial<CopilotSession>
  if (
    typeof value.copilotToken !== 'string' ||
    typeof value.copilotExpiresAt !== 'number' ||
    typeof value.apiBaseUrl !== 'string'
  ) {
    return undefined
  }
  return {
    copilotToken: value.copilotToken,
    copilotExpiresAt: value.copilotExpiresAt,
    apiBaseUrl: value.apiBaseUrl,
  }
}

export class CopilotOAuthStore {
  private readonly dir: string
  private readonly file: string

  constructor(
    private readonly app: App,
    pluginId: string,
    providerId: string,
  ) {
    this.dir = normalizePath(
      path.posix.join(
        this.app.vault.configDir,
        'plugins',
        pluginId,
        CREDENTIAL_DIR_NAME,
      ),
    )
    this.file = normalizePath(
      path.posix.join(this.dir, `${encodeURIComponent(providerId)}.json`),
    )
  }

  async get(): Promise<CopilotOAuthCredential | null> {
    const exists = await this.app.vault.adapter.exists(this.file)
    if (!exists) {
      return null
    }

    try {
      const raw = await this.app.vault.adapter.read(this.file)
      const parsed = JSON.parse(raw) as Partial<CopilotOAuthCredential>
      if (
        typeof parsed.githubToken !== 'string' ||
        typeof parsed.updatedAt !== 'number'
      ) {
        return null
      }
      const session = parseSession(parsed.session)
      return {
        githubToken: parsed.githubToken,
        updatedAt: parsed.updatedAt,
        ...(session ? { session } : {}),
      }
    } catch {
      return null
    }
  }

  async set(credential: CopilotOAuthCredential): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.dir))) {
      await this.app.vault.adapter.mkdir(this.dir)
    }
    await this.app.vault.adapter.write(
      this.file,
      JSON.stringify(credential, null, 2),
    )
  }

  async clear(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.file))) {
      return
    }
    await this.app.vault.adapter.remove(this.file)
  }
}
