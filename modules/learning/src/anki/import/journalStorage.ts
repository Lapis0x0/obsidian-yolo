import type { AnkiImportJournalStorage, AnkiJournalFilePort } from './ports'

export const ANKI_IMPORT_JOURNAL_DIR_NAME = 'anki-import-journals'

const normalizePath = (path: string): string =>
  path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')

export class FileAnkiImportJournalStorage implements AnkiImportJournalStorage {
  private readonly knownPaths = new Set<string>()

  constructor(
    private readonly files: AnkiJournalFilePort,
    private readonly getLearningDataRootDir: () => Promise<string>,
  ) {}

  async create(content: string): Promise<string> {
    const directory = await this.ensureDirectory()
    const path = normalizePath(`${directory}/${crypto.randomUUID()}.json`)
    await this.files.write(path, content)
    this.knownPaths.add(path)
    return path
  }

  write(path: string, content: string): Promise<void> {
    return this.files.write(this.assertKnownPath(path), content)
  }

  async list(): Promise<readonly string[]> {
    const listing = await this.files.list(await this.ensureDirectory())
    const paths = listing.files
      .filter((path) => path.endsWith('.json'))
      .map(normalizePath)
    paths.forEach((path) => this.knownPaths.add(path))
    return paths
  }

  read(path: string): Promise<string> {
    return this.files.read(this.assertKnownPath(path))
  }

  async remove(path: string): Promise<void> {
    const normalized = this.assertKnownPath(path)
    if (await this.files.exists(normalized)) await this.files.remove(normalized)
    this.knownPaths.delete(normalized)
  }

  private async ensureDirectory(): Promise<string> {
    const directory = normalizePath(
      `${await this.getLearningDataRootDir()}/${ANKI_IMPORT_JOURNAL_DIR_NAME}`,
    )
    if (!(await this.files.exists(directory))) await this.files.mkdir(directory)
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
