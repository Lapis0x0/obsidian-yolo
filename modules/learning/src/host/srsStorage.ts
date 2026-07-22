import type { SrsStorage, SrsStorageReadResult } from '../domain/srs/srsStorage'
import { LearningSrsStore } from '../domain/srs/srsStore'

import {
  getBaseDirFromContentRoot,
  normalizeVaultPath,
  runWithLearningManagedDataLock,
} from './paths'

type HostVault = YoloModuleHostApiV1['vault']
type RunMutation = <T>(operation: () => T | PromiseLike<T>) => Promise<T>

const JSON_DB_DIR_NAME = '.yolo_json_db'
const LEGACY_JSON_DB_DIR_NAME = '.smtcmp_json_db'
const SRS_DIR_NAME = 'learning-srs'

export type HostLearningSrsOptions = Readonly<{
  srsStore?: LearningSrsStore
  srsStorage?: SrsStorage
}>

export const createHostLearningSrsStorage = (
  host: Pick<YoloModuleHostApiV1, 'paths' | 'vault'>,
): HostLearningSrsStorage =>
  new HostLearningSrsStorage(
    host.vault,
    () => getBaseDirFromContentRoot(host.paths.getSnapshot().contentRoot),
    (operation) => runWithLearningManagedDataLock(host.paths, operation),
  )

export const createUnlockedHostLearningSrsStorage = (
  host: Pick<YoloModuleHostApiV1, 'paths' | 'vault'>,
): HostLearningSrsStorage =>
  new HostLearningSrsStorage(
    host.vault,
    () => getBaseDirFromContentRoot(host.paths.getSnapshot().contentRoot),
    async (operation) => await operation(),
  )

export const resolveHostLearningSrsStore = (
  host: Pick<YoloModuleHostApiV1, 'paths' | 'vault'>,
  options: HostLearningSrsOptions = {},
): LearningSrsStore => {
  if (options.srsStore && options.srsStorage) {
    throw new Error('Provide either srsStore or srsStorage, not both')
  }
  return (
    options.srsStore ??
    new HostLearningSrsStore(
      host.paths,
      options.srsStorage ?? createUnlockedHostLearningSrsStorage(host),
    )
  )
}

class HostLearningSrsStore extends LearningSrsStore {
  constructor(
    private readonly paths: Pick<YoloModuleHostApiV1['paths'], 'runExclusive'>,
    storage: SrsStorage,
  ) {
    super(storage)
  }

  override initializeProjectState(
    ...args: Parameters<LearningSrsStore['initializeProjectState']>
  ): ReturnType<LearningSrsStore['initializeProjectState']> {
    return this.runManagedMutation(() => super.initializeProjectState(...args))
  }

  override initializeProjectStateAtPath(
    ...args: Parameters<LearningSrsStore['initializeProjectStateAtPath']>
  ): ReturnType<LearningSrsStore['initializeProjectStateAtPath']> {
    return this.runManagedMutation(() =>
      super.initializeProjectStateAtPath(...args),
    )
  }

  override deleteProjectState(
    ...args: Parameters<LearningSrsStore['deleteProjectState']>
  ): ReturnType<LearningSrsStore['deleteProjectState']> {
    return this.runManagedMutation(() => super.deleteProjectState(...args))
  }

  override deletePersistedProjectStateAtPath(
    ...args: Parameters<LearningSrsStore['deletePersistedProjectStateAtPath']>
  ): ReturnType<LearningSrsStore['deletePersistedProjectStateAtPath']> {
    return this.runManagedMutation(() =>
      super.deletePersistedProjectStateAtPath(...args),
    )
  }

  override pauseProject(
    ...args: Parameters<LearningSrsStore['pauseProject']>
  ): ReturnType<LearningSrsStore['pauseProject']> {
    return this.runManagedMutation(() => super.pauseProject(...args))
  }

  override resumeProject(
    ...args: Parameters<LearningSrsStore['resumeProject']>
  ): ReturnType<LearningSrsStore['resumeProject']> {
    return this.runManagedMutation(() => super.resumeProject(...args))
  }

  override reviewCard(
    ...args: Parameters<LearningSrsStore['reviewCard']>
  ): ReturnType<LearningSrsStore['reviewCard']> {
    return this.runManagedMutation(() => super.reviewCard(...args))
  }

  override reviewCards(
    ...args: Parameters<LearningSrsStore['reviewCards']>
  ): ReturnType<LearningSrsStore['reviewCards']> {
    return this.runManagedMutation(() => super.reviewCards(...args))
  }

  override suspendCards(
    ...args: Parameters<LearningSrsStore['suspendCards']>
  ): ReturnType<LearningSrsStore['suspendCards']> {
    return this.runManagedMutation(() => super.suspendCards(...args))
  }

  override resumeCards(
    ...args: Parameters<LearningSrsStore['resumeCards']>
  ): ReturnType<LearningSrsStore['resumeCards']> {
    return this.runManagedMutation(() => super.resumeCards(...args))
  }

  override removeCards(
    ...args: Parameters<LearningSrsStore['removeCards']>
  ): ReturnType<LearningSrsStore['removeCards']> {
    return this.runManagedMutation(() => super.removeCards(...args))
  }

  override pruneOrphanedCards(
    ...args: Parameters<LearningSrsStore['pruneOrphanedCards']>
  ): ReturnType<LearningSrsStore['pruneOrphanedCards']> {
    return this.runManagedMutation(() => super.pruneOrphanedCards(...args))
  }

  private runManagedMutation<T>(operation: () => Promise<T>): Promise<T> {
    return runWithLearningManagedDataLock(this.paths, operation)
  }
}

export class HostLearningSrsStorage implements SrsStorage {
  private ensureRootPromise: { key: string; value: Promise<string> } | null =
    null
  private ensureDirectoryPromise: {
    key: string
    value: Promise<string>
  } | null = null

  constructor(
    private readonly vault: HostVault,
    private readonly getBaseDir: () => string,
    private readonly runMutation: RunMutation,
  ) {}

  getLocationKey(): string {
    return `${normalizeVaultPath(this.getBaseDir())}/${JSON_DB_DIR_NAME}`
  }

  ensureRoot(): Promise<string> {
    return this.runMutation(() => this.ensureRootUnlocked())
  }

  private ensureRootUnlocked(): Promise<string> {
    const key = this.getLocationKey()
    let request = this.ensureRootPromise
    if (!request || request.key !== key) {
      request = {
        key,
        value: this.vault.ensureFolder(key).then(() => key),
      }
      this.ensureRootPromise = request
    }
    return request.value.finally(() => {
      if (this.ensureRootPromise === request) this.ensureRootPromise = null
    })
  }

  async ensure(projectSlug: string): Promise<string> {
    assertProjectSlug(projectSlug)
    return this.runMutation(async () =>
      this.ensureProjectPathUnlocked(projectSlug),
    )
  }

  async exists(projectSlug: string): Promise<boolean> {
    return this.vault.exists(this.getProjectPath(projectSlug))
  }

  async read(projectSlug: string): Promise<SrsStorageReadResult | null> {
    const path = this.getProjectPath(projectSlug)
    if (!(await this.vault.exists(path))) return null
    return { path, content: await this.vault.readText(path) }
  }

  async write(projectSlug: string, content: string): Promise<string> {
    assertProjectSlug(projectSlug)
    return this.runMutation(async () => {
      const path = await this.ensureProjectPathUnlocked(projectSlug)
      await this.writeText(path, content)
      return path
    })
  }

  async writeProjectStateAtPath(
    projectSlug: string,
    path: string,
    content: string,
  ): Promise<void> {
    const validated = validateProjectStatePath(projectSlug, path)
    await this.runMutation(() => this.writeText(validated, content))
  }

  async remove(projectSlug: string): Promise<boolean> {
    assertProjectSlug(projectSlug)
    return this.runMutation(() =>
      this.vault.removeFileExact(this.getProjectPath(projectSlug)),
    )
  }

  existsProjectStateAtPath(
    projectSlug: string,
    path: string,
  ): Promise<boolean> {
    return this.vault.exists(validateProjectStatePath(projectSlug, path))
  }

  async removeProjectStateAtPath(
    projectSlug: string,
    path: string,
  ): Promise<boolean> {
    const validated = validateProjectStatePath(projectSlug, path)
    return this.runMutation(() => this.vault.removeFileExact(validated))
  }

  private ensureDirectory(): Promise<string> {
    const key = this.getLocationKey()
    let request = this.ensureDirectoryPromise
    if (!request || request.key !== key) {
      request = { key, value: this.ensureDirectoryInternal() }
      this.ensureDirectoryPromise = request
    }
    return request.value.finally(() => {
      if (this.ensureDirectoryPromise === request) {
        this.ensureDirectoryPromise = null
      }
    })
  }

  private async ensureDirectoryInternal(): Promise<string> {
    const directory = `${await this.ensureRootUnlocked()}/${SRS_DIR_NAME}`
    await this.vault.ensureFolder(directory)
    return directory
  }

  private async writeText(path: string, content: string): Promise<void> {
    const created = await this.vault.createTextIfAbsent(path, content)
    if (!created) await this.vault.writeText(path, content)
  }

  private getProjectPath(projectSlug: string): string {
    assertProjectSlug(projectSlug)
    return `${this.getLocationKey()}/${SRS_DIR_NAME}/${projectSlug}.json`
  }

  private async ensureProjectPathUnlocked(
    projectSlug: string,
  ): Promise<string> {
    return `${await this.ensureDirectory()}/${projectSlug}.json`
  }
}

export function validateProjectStatePath(
  projectSlug: string,
  path: string,
): string {
  assertProjectSlug(projectSlug)
  const normalized = normalizeVaultPath(path)
  const suffix = `/${SRS_DIR_NAME}/${projectSlug}.json`
  const managed = [JSON_DB_DIR_NAME, LEGACY_JSON_DB_DIR_NAME].some(
    (root) =>
      normalized === `${root}${suffix}` ||
      normalized.endsWith(`/${root}${suffix}`),
  )
  if (!managed) {
    throw new Error(`Invalid Learning SRS project state path: ${path}`)
  }
  return normalized
}

function assertProjectSlug(projectSlug: string): void {
  if (
    !projectSlug ||
    projectSlug === '.' ||
    projectSlug === '..' ||
    projectSlug.includes('/') ||
    projectSlug.includes('\\')
  ) {
    throw new Error(`Invalid Learning project slug: ${projectSlug}`)
  }
}
