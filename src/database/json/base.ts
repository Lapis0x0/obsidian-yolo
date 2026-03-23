import { App, normalizePath } from 'obsidian'
import path from 'path-browserify'

export abstract class AbstractJsonRepository<T, M> {
  protected dataDir: string
  protected app: App
  private writeQueue: Promise<void> = Promise.resolve()
  private ensureDirectoryPromise: Promise<void> | null = null

  constructor(app: App, dataDir: string) {
    this.app = app
    this.dataDir = normalizePath(dataDir)
    void this.ensureRepositoryDir().catch((error) => {
      console.error(
        `[YOLO] Failed to ensure data directory "${this.dataDir}":`,
        error,
      )
    })
  }

  private ensureRepositoryDir(): Promise<void> {
    return this.app.vault.adapter.exists(this.dataDir).then((exists) => {
      if (exists) {
        return
      }
      if (!this.ensureDirectoryPromise) {
        this.ensureDirectoryPromise =
          this.ensureRepositoryDirInternal().finally(() => {
            this.ensureDirectoryPromise = null
          })
      }
      return this.ensureDirectoryPromise
    })
  }

  private async ensureRepositoryDirInternal(): Promise<void> {
    try {
      await this.app.vault.adapter.mkdir(this.dataDir)
    } catch (error) {
      if (await this.app.vault.adapter.exists(this.dataDir)) {
        return
      }
      throw error
    }
  }

  protected enqueueWrite<R>(operation: () => Promise<R>): Promise<R> {
    const next = this.writeQueue.then(operation, operation)
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  protected writeFile(filePath: string, content: string): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.ensureRepositoryDir()
      try {
        await this.app.vault.adapter.write(filePath, content)
      } catch (error) {
        if (
          await this.handleAtomicWriteTempFileError(error, filePath, content)
        ) {
          return
        }
        if (
          await this.handleMissingDirectoryOnWrite(error, filePath, content)
        ) {
          return
        }
        throw error
      }
    })
  }

  protected removeFile(filePath: string): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.ensureRepositoryDir()
      try {
        await this.app.vault.adapter.remove(filePath)
      } catch (error) {
        if (this.isEnoentError(error)) {
          return
        }
        throw error
      }
    })
  }

  private async handleAtomicWriteTempFileError(
    error: unknown,
    filePath: string,
    content: string,
  ): Promise<boolean> {
    if (!this.isAtomicWriteTempFileEnoent(error)) {
      return false
    }

    // Obsidian adapter may throw ENOENT when cleaning tmp files even if write succeeded.
    if (await this.app.vault.adapter.exists(filePath)) {
      return true
    }

    await this.app.vault.adapter.write(filePath, content)
    return true
  }

  private async handleMissingDirectoryOnWrite(
    error: unknown,
    filePath: string,
    content: string,
  ): Promise<boolean> {
    if (!this.isEnoentError(error)) {
      return false
    }

    await this.ensureRepositoryDir()
    await this.app.vault.adapter.write(filePath, content)
    return true
  }

  private isAtomicWriteTempFileEnoent(error: unknown): boolean {
    if (!this.isEnoentError(error)) {
      return false
    }

    const message = this.getErrorMessage(error)
    return message.includes('unlink') && message.includes('tmp_')
  }

  private isEnoentError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false
    }

    const code = (error as { code?: unknown }).code
    return code === 'ENOENT'
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }
    return typeof error === 'string' ? error : ''
  }

  // Each subclass implements how to generate a file name from a data row.
  protected abstract generateFileName(row: T): string

  // Each subclass implements how to parse a file name into metadata.
  protected abstract parseFileName(fileName: string): M | null

  public async create(row: T): Promise<void> {
    const fileName = this.generateFileName(row)
    const filePath = normalizePath(path.join(this.dataDir, fileName))
    const content = JSON.stringify(row, null, 2)

    if (await this.app.vault.adapter.exists(filePath)) {
      throw new Error(`File already exists: ${filePath}`)
    }

    await this.writeFile(filePath, content)
  }

  public async update(oldRow: T, newRow: T): Promise<void> {
    const oldFileName = this.generateFileName(oldRow)
    const newFileName = this.generateFileName(newRow)
    const content = JSON.stringify(newRow, null, 2)

    if (oldFileName === newFileName) {
      // Simple update - filename hasn't changed
      const filePath = normalizePath(path.join(this.dataDir, oldFileName))
      await this.writeFile(filePath, content)
    } else {
      // Filename has changed - create new file and delete old one
      const newFilePath = normalizePath(path.join(this.dataDir, newFileName))
      await this.writeFile(newFilePath, content)
      await this.delete(oldFileName)
    }
  }

  // List metadata for all records by parsing file names.
  public async listMetadata(): Promise<(M & { fileName: string })[]> {
    await this.ensureRepositoryDir()
    const files = await this.app.vault.adapter.list(this.dataDir)
    return files.files
      .map((filePath) => path.basename(filePath))
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) => {
        const metadata = this.parseFileName(fileName)
        return metadata ? { ...metadata, fileName } : null
      })
      .filter(
        (metadata): metadata is M & { fileName: string } => metadata !== null,
      )
  }

  public async read(fileName: string): Promise<T | null> {
    await this.ensureRepositoryDir()
    const filePath = normalizePath(path.join(this.dataDir, fileName))
    if (!(await this.app.vault.adapter.exists(filePath))) return null

    const content = await this.app.vault.adapter.read(filePath)
    return JSON.parse(content) as T
  }

  public async delete(fileName: string): Promise<void> {
    await this.ensureRepositoryDir()
    const filePath = normalizePath(path.join(this.dataDir, fileName))
    if (await this.app.vault.adapter.exists(filePath)) {
      await this.removeFile(filePath)
    }
  }
}
