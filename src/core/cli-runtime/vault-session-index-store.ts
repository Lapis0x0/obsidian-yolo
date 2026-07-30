import { App, normalizePath } from 'obsidian'

import { ensureJsonDbRootDir } from '../paths/yoloManagedData'

import {
  CLI_SESSION_INDEX_SCHEMA_VERSION,
  type CliSessionIndexDocument,
  type CliSessionIndexEntry,
  type CliSessionIndexStore,
  cliSessionIndexDocumentSchema,
  getCliSessionIndexKey,
} from './session-index'
import type { CliSessionRef } from './types'

const CLI_SESSION_INDEX_FILE_NAME = 'cli_session_index.json'

type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

const emptyDocument = (): CliSessionIndexDocument => ({
  schemaVersion: CLI_SESSION_INDEX_SCHEMA_VERSION,
  sessions: {},
})

export class VaultCliSessionIndexStore implements CliSessionIndexStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly app: App,
    private readonly settings: YoloSettingsLike | null = null,
  ) {}

  async list(): Promise<CliSessionIndexEntry[]> {
    return Object.values((await this.readDocument()).sessions).sort(
      (left, right) =>
        (right.pinnedAt ?? right.lastOpenedAt ?? 0) -
        (left.pinnedAt ?? left.lastOpenedAt ?? 0),
    )
  }

  async get(ref: CliSessionRef): Promise<CliSessionIndexEntry | null> {
    return (
      (await this.readDocument()).sessions[getCliSessionIndexKey(ref)] ?? null
    )
  }

  async upsert(entry: CliSessionIndexEntry): Promise<void> {
    await this.enqueueWrite(async () => {
      const document = await this.readDocument()
      document.sessions[getCliSessionIndexKey(entry)] = entry
      await this.writeDocument(document)
    })
  }

  async remove(ref: CliSessionRef): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const document = await this.readDocument()
      const key = getCliSessionIndexKey(ref)
      if (!document.sessions[key]) return false
      delete document.sessions[key]
      await this.writeDocument(document)
      return true
    })
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation)
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async getFilePath(): Promise<string> {
    const root = await ensureJsonDbRootDir(this.app, this.settings)
    return normalizePath(`${root}/${CLI_SESSION_INDEX_FILE_NAME}`)
  }

  private async readDocument(): Promise<CliSessionIndexDocument> {
    const filePath = await this.getFilePath()
    if (!(await this.app.vault.adapter.exists(filePath))) {
      return emptyDocument()
    }

    const content = await this.app.vault.adapter.read(filePath)
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : ''
      throw new Error(`Failed to parse ${CLI_SESSION_INDEX_FILE_NAME}.${detail}`)
    }
    return cliSessionIndexDocumentSchema.parse(parsed)
  }

  private async writeDocument(
    document: CliSessionIndexDocument,
  ): Promise<void> {
    const validated = cliSessionIndexDocumentSchema.parse(document)
    await this.app.vault.adapter.write(
      await this.getFilePath(),
      `${JSON.stringify(validated, null, 2)}\n`,
    )
  }
}
