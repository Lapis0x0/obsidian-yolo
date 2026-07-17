import { App, normalizePath } from 'obsidian'

import {
  type YoloSettingsLike,
  ensureLearningJsonDbRootDir,
} from '../../paths/yoloManagedData'
import {
  LEGACY_JSON_DB_DIR_NAME,
  YOLO_JSON_DB_DIR_NAME,
  YOLO_LEARNING_SRS_DIR_NAME,
  getYoloJsonDbRootDir,
} from '../../paths/yoloPaths'

import type {
  LearningSrsStorage,
  LearningSrsStorageReadResult,
} from './learningSrsStorage'

export class ObsidianLearningSrsStorage implements LearningSrsStorage {
  private ensureRootPromise: { key: string; value: Promise<string> } | null =
    null
  private activeRoot: { key: string; value: string } | null = null
  private ensureDirectoryPromise: {
    key: string
    value: Promise<string>
  } | null = null

  constructor(
    private readonly app: App,
    private readonly getSettings: () => YoloSettingsLike | null,
  ) {}

  getLocationKey(): string {
    return getYoloJsonDbRootDir(this.getSettings())
  }

  ensureRoot(): Promise<string> {
    const settings = this.getSettings()
    const key = getYoloJsonDbRootDir(settings)
    if (this.activeRoot?.key === key)
      return Promise.resolve(this.activeRoot.value)
    let request = this.ensureRootPromise
    if (!request || request.key !== key) {
      request = {
        key,
        value: ensureLearningJsonDbRootDir(this.app, settings),
      }
      this.ensureRootPromise = request
    }
    return request.value
      .then((root) => {
        this.activeRoot = { key, value: root }
        return root
      })
      .finally(() => {
        if (this.ensureRootPromise === request) this.ensureRootPromise = null
      })
  }

  async ensure(projectSlug: string): Promise<string> {
    const directory = await this.ensureDirectory()
    return normalizePath(`${directory}/${projectSlug}.json`)
  }

  async read(
    projectSlug: string,
  ): Promise<LearningSrsStorageReadResult | null> {
    const path = await this.ensure(projectSlug)
    if (!(await this.app.vault.adapter.exists(path))) return null
    return { path, content: await this.app.vault.adapter.read(path) }
  }

  async exists(projectSlug: string): Promise<boolean> {
    return this.app.vault.adapter.exists(await this.ensure(projectSlug))
  }

  async write(projectSlug: string, content: string): Promise<string> {
    const path = await this.ensure(projectSlug)
    await this.app.vault.adapter.write(path, content)
    return path
  }

  async writeProjectStateAtPath(
    projectSlug: string,
    path: string,
    content: string,
  ): Promise<void> {
    await this.app.vault.adapter.write(
      this.validateProjectStatePath(projectSlug, path),
      content,
    )
  }

  async remove(projectSlug: string): Promise<boolean> {
    const path = await this.ensure(projectSlug)
    if (!(await this.app.vault.adapter.exists(path))) return false
    await this.app.vault.adapter.remove(path)
    return true
  }

  async existsProjectStateAtPath(
    projectSlug: string,
    path: string,
  ): Promise<boolean> {
    return this.app.vault.adapter.exists(
      this.validateProjectStatePath(projectSlug, path),
    )
  }

  async removeProjectStateAtPath(
    projectSlug: string,
    path: string,
  ): Promise<boolean> {
    const validated = this.validateProjectStatePath(projectSlug, path)
    if (!(await this.app.vault.adapter.exists(validated))) return false
    await this.app.vault.adapter.remove(validated)
    return true
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
    const root = await this.ensureRoot()
    if (!(await this.app.vault.adapter.exists(root))) {
      await this.app.vault.adapter.mkdir(root)
    }
    const directory = normalizePath(`${root}/${YOLO_LEARNING_SRS_DIR_NAME}`)
    if (!(await this.app.vault.adapter.exists(directory))) {
      await this.app.vault.adapter.mkdir(directory)
    }
    return directory
  }

  private validateProjectStatePath(projectSlug: string, path: string): string {
    const normalized = normalizePath(path)
    const suffix = `/${YOLO_LEARNING_SRS_DIR_NAME}/${projectSlug}.json`
    const managedRoots = [YOLO_JSON_DB_DIR_NAME, LEGACY_JSON_DB_DIR_NAME]
    const isManaged = managedRoots.some((root) => {
      const managedPath = `${root}${suffix}`
      return (
        normalized === managedPath || normalized.endsWith(`/${managedPath}`)
      )
    })
    if (!isManaged) {
      throw new Error(`Invalid Learning SRS project state path: ${path}`)
    }
    return normalized
  }
}
