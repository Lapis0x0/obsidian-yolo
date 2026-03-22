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

const CREDENTIAL_DIR_NAME = 'chatgpt-oauth'
const LEGACY_CREDENTIAL_FILE_NAME = 'chatgpt-oauth.json'
const DEFAULT_PROVIDER_ID = 'chatgpt-oauth'
const EXPIRY_BUFFER_MS = 30_000

const encodeProviderId = (providerId: string): string =>
  encodeURIComponent(providerId)

export class ChatGPTOAuthStore {
  private readonly dir: string
  private readonly file: string
  private readonly legacyFile: string

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
    this.legacyFile = normalizePath(
      path.posix.join(this.dir, LEGACY_CREDENTIAL_FILE_NAME),
    )
  }

  getFilePath(): string {
    return this.file
  }

  async get(): Promise<ChatGPTOAuthCredential | null> {
    await this.migrateLegacyCredentialIfNeeded()
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
    const credentialDir = normalizePath(
      path.posix.join(this.dir, CREDENTIAL_DIR_NAME),
    )
    const exists = await this.app.vault.adapter.exists(credentialDir)
    if (exists) {
      return
    }
    await this.app.vault.adapter.mkdir(credentialDir)
  }

  private async migrateLegacyCredentialIfNeeded(): Promise<void> {
    if (this.providerId !== DEFAULT_PROVIDER_ID) {
      return
    }

    const currentExists = await this.app.vault.adapter.exists(this.file)
    if (currentExists) {
      return
    }

    const legacyExists = await this.app.vault.adapter.exists(this.legacyFile)
    if (!legacyExists) {
      return
    }

    await this.ensureDir()
    const raw = await this.app.vault.adapter.read(this.legacyFile)
    await this.app.vault.adapter.write(this.file, raw)
    await this.app.vault.adapter.remove(this.legacyFile)
  }
}
