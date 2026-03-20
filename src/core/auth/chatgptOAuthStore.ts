import { App, normalizePath } from 'obsidian'
import path from 'path-browserify'

export type ChatGPTOAuthCredential = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId?: string
  idToken?: string
  updatedAt: number
}

const CREDENTIAL_FILE_NAME = 'chatgpt-oauth.json'
const EXPIRY_BUFFER_MS = 30_000

export class ChatGPTOAuthStore {
  private readonly dir: string
  private readonly file: string

  constructor(
    private readonly app: App,
    pluginId: string,
  ) {
    this.dir = normalizePath(`${this.app.vault.configDir}/plugins/${pluginId}`)
    this.file = normalizePath(path.posix.join(this.dir, CREDENTIAL_FILE_NAME))
  }

  getFilePath(): string {
    return this.file
  }

  async get(): Promise<ChatGPTOAuthCredential | null> {
    const exists = await this.app.vault.adapter.exists(this.file)
    if (!exists) {
      return null
    }

    try {
      const raw = await this.app.vault.adapter.read(this.file)
      const parsed = JSON.parse(raw) as Partial<ChatGPTOAuthCredential>
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
        ...(typeof parsed.accountId === 'string'
          ? { accountId: parsed.accountId }
          : {}),
        ...(typeof parsed.idToken === 'string'
          ? { idToken: parsed.idToken }
          : {}),
      }
    } catch {
      return null
    }
  }

  async set(credential: ChatGPTOAuthCredential): Promise<void> {
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

  isExpired(credential: Pick<ChatGPTOAuthCredential, 'expiresAt'>): boolean {
    return credential.expiresAt <= Date.now() + EXPIRY_BUFFER_MS
  }

  private async ensureDir(): Promise<void> {
    const exists = await this.app.vault.adapter.exists(this.dir)
    if (exists) {
      return
    }
    await this.app.vault.adapter.mkdir(this.dir)
  }
}
