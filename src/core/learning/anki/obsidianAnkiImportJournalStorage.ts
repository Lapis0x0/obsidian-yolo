import { App, normalizePath } from 'obsidian'

import { YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME } from '../../paths/yoloPaths'

import type { AnkiImportJournalStorage } from './ankiImportJournalStorage'

export class ObsidianAnkiImportJournalStorage
  implements AnkiImportJournalStorage
{
  private readonly knownPaths = new Set<string>()

  constructor(
    private readonly app: App,
    private readonly getLearningDataRootDir: () => Promise<string>,
  ) {}

  async create(content: string): Promise<string> {
    const directory = await this.ensureDirectory()
    const path = normalizePath(`${directory}/${crypto.randomUUID()}.json`)
    await this.app.vault.adapter.write(path, content)
    this.knownPaths.add(path)
    return path
  }

  write(path: string, content: string): Promise<void> {
    return this.app.vault.adapter.write(this.assertKnownPath(path), content)
  }

  async list(): Promise<readonly string[]> {
    const listing = await this.app.vault.adapter.list(
      await this.ensureDirectory(),
    )
    const paths = listing.files.filter((path) => path.endsWith('.json'))
    paths.forEach((path) => this.knownPaths.add(normalizePath(path)))
    return paths
  }

  read(path: string): Promise<string> {
    return this.app.vault.adapter.read(this.assertKnownPath(path))
  }

  async remove(path: string): Promise<void> {
    const normalized = this.assertKnownPath(path)
    if (await this.app.vault.adapter.exists(normalized)) {
      await this.app.vault.adapter.remove(normalized)
    }
    this.knownPaths.delete(normalized)
  }

  private async ensureDirectory(): Promise<string> {
    const root = await this.getLearningDataRootDir()
    const directory = normalizePath(
      `${root}/${YOLO_ANKI_IMPORT_JOURNAL_DIR_NAME}`,
    )
    if (!(await this.app.vault.adapter.exists(directory))) {
      await this.app.vault.adapter.mkdir(directory)
    }
    return directory
  }

  private assertKnownPath(path: string): string {
    const normalized = normalizePath(path)
    if (!this.knownPaths.has(normalized)) {
      throw new Error(`Unknown Anki import journal path: ${path}`)
    }
    return normalized
  }
}
