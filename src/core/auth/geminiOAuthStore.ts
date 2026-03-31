import { App, normalizePath } from 'obsidian'
import path from 'path-browserify'

export type GeminiOAuthCredential = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  updatedAt: number
  email?: string
  projectId?: string
  managedProjectId?: string
}

const CREDENTIAL_DIR_NAME = 'gemini-oauth'
const DEFAULT_PROVIDER_ID = 'gemini-oauth'
const EXPIRY_BUFFER_MS = 60_000

const encodeProviderId = (providerId: string): string =>
  encodeURIComponent(providerId)

export class GeminiOAuthStore {
  private readonly dir: string
  private readonly file: string

  constructor(
    private readonly app: App,
    pluginId: string,
    private readonly providerId = DEFAULT_PROVIDER_ID,
  ) {
    this.dir = normalizePath(`${this.app.vault.configDir}/plugins/${pluginId}`)
    this.file = normalizePath(
      path.posix.join(
        this.dir,
        CREDENTIAL_DIR_NAME,
        `${encodeProviderId(this.providerId)}.json`,
      ),
    )
  }

  getFilePath(): string {
    return this.file
  }

  async get(): Promise<GeminiOAuthCredential | null> {
    const exists = await this.app.vault.adapter.exists(this.file)
    if (!exists) {
      return null
    }

    try {
      const raw = await this.app.vault.adapter.read(this.file)
      const parsed = JSON.parse(raw) as Partial<GeminiOAuthCredential>
      if (
        typeof parsed.accessToken !== 'string' ||
        typeof parsed.refreshToken !== 'string' ||
        typeof parsed.expiresAt !== 'number' ||
        typeof parsed.updatedAt !== 'number'
      ) {
        return null
      }

      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
        updatedAt: parsed.updatedAt,
        ...(typeof parsed.email === 'string' ? { email: parsed.email } : {}),
        ...(typeof parsed.projectId === 'string'
          ? { projectId: parsed.projectId }
          : {}),
        ...(typeof parsed.managedProjectId === 'string'
          ? { managedProjectId: parsed.managedProjectId }
          : {}),
      }
    } catch {
      return null
    }
  }

  async set(credential: GeminiOAuthCredential): Promise<void> {
    await this.ensureDir()
    await this.app.vault.adapter.write(
      this.file,
      JSON.stringify(credential, null, 2),
    )
  }

  async clear(): Promise<void> {
    const exists = await this.app.vault.adapter.exists(this.file)
    if (!exists) {
      return
    }
    await this.app.vault.adapter.remove(this.file)
  }

  isExpired(credential: Pick<GeminiOAuthCredential, 'expiresAt'>): boolean {
    return credential.expiresAt <= Date.now() + EXPIRY_BUFFER_MS
  }

  private async ensureDir(): Promise<void> {
    const credentialDir = normalizePath(
      path.posix.join(this.dir, CREDENTIAL_DIR_NAME),
    )
    const exists = await this.app.vault.adapter.exists(credentialDir)
    if (exists) {
      return
    }
    await this.app.vault.adapter.mkdir(credentialDir)
  }
}
