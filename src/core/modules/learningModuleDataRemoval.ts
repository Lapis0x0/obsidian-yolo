import { type App, TFile, TFolder, normalizePath } from 'obsidian'
import { z } from 'zod'

import { getYoloJsonDbRootDir, getYoloLearningDir } from '../paths/yoloPaths'

import type { IndexedDbDataAdapter } from './indexedDbDataAdapter'
import {
  managedModuleDataNamespace,
  runExclusive as runManagedModuleDataExclusive,
} from './managedModuleDataLock'
import type { ModuleIntentStore } from './moduleIntentStore'
import type { ModuleRuntimeQuiescence } from './moduleRuntimeReservation'
import { assertModulePathSegment } from './moduleStore'

const LEARNING_MODULE_ID = 'learning'
const ANKI_RUNTIME_NAMESPACE = 'anki-runtime'
const ANKI_RUNTIME_PATH = 'module-private-device-local/learning/anki-runtime'
const JOURNAL_ROOT = 'module-data-removal-journals'
const JOURNAL_PATH = `${JOURNAL_ROOT}/learning.json`
const MAX_TARGETS = 256
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type LearningRemovalSettings = Readonly<{
  yolo?: Readonly<{ baseDir?: string }>
}>

const projectTargetSchema = z
  .object({ kind: z.literal('project'), projectSlug: z.string() })
  .strict()
const srsTargetSchema = z
  .object({ kind: z.literal('srs'), projectSlug: z.string() })
  .strict()
const importJournalTargetSchema = z
  .object({
    kind: z.literal('anki-import-journal'),
    journalId: z.string().regex(UUID),
  })
  .strict()
const settingsTargetSchema = z.object({ kind: z.literal('settings') }).strict()
const ankiRuntimeTargetSchema = z
  .object({ kind: z.literal('anki-runtime') })
  .strict()

const targetSchema = z.discriminatedUnion('kind', [
  projectTargetSchema,
  srsTargetSchema,
  importJournalTargetSchema,
  settingsTargetSchema,
  ankiRuntimeTargetSchema,
])

const journalSchema = z
  .object({
    version: z.literal(1),
    targets: z.array(targetSchema).min(1).max(MAX_TARGETS),
    completedTargetIds: z.array(z.string()),
  })
  .strict()

export type LearningDataRemovalTarget = z.infer<typeof targetSchema>
export type LearningDataRemovalJournal = z.infer<typeof journalSchema>

type DeviceLocalData = Pick<
  IndexedDbDataAdapter,
  'mkdir' | 'read' | 'remove' | 'stat' | 'write'
>

export type LearningModuleDataRemovalServiceOptions = Readonly<{
  app: App
  getSettings(): LearningRemovalSettings
  deviceLocal: DeviceLocalData
  intentStore: Pick<ModuleIntentStore, 'get' | 'set'>
  artifactUninstaller: Readonly<{ uninstall(moduleId: string): Promise<void> }>
  runtime: ModuleRuntimeQuiescence
}>

/** Core-owned destructive path for Learning data. Ordinary uninstall never calls it. */
export class LearningModuleDataRemovalService {
  private running = false

  constructor(
    private readonly options: LearningModuleDataRemovalServiceOptions,
  ) {}

  async uninstallAndRemoveData(): Promise<void> {
    if (this.running) {
      throw new Error('Learning data removal is already in progress')
    }
    this.running = true
    try {
      await this.options.intentStore.set(LEARNING_MODULE_ID, 'uninstalled')
      await this.options.artifactUninstaller.uninstall(LEARNING_MODULE_ID)
      await this.options.runtime.runWithModuleQuiesced(LEARNING_MODULE_ID, () =>
        runManagedModuleDataExclusive(
          this.options.app.vault,
          managedModuleDataNamespace(LEARNING_MODULE_ID, 'managed-data'),
          () => this.removeDataWithJournal(),
        ),
      )
    } finally {
      this.running = false
    }
  }

  private async removeDataWithJournal(): Promise<void> {
    const intent = await this.options.intentStore.get(LEARNING_MODULE_ID)
    if (intent !== 'uninstalled') {
      throw new Error('Learning data removal requires uninstalled intent')
    }

    const stored = await this.readJournal()
    const targets = stored?.targets ?? (await this.enumerateTargets())
    validateTargets(targets)
    const completedTargetIds = stored?.completedTargetIds ?? []
    const completed = new Set(completedTargetIds)
    if (completed.size !== completedTargetIds.length) {
      throw new Error('Learning data removal journal has duplicate targets')
    }
    validateCompletedTargets(targets, completed)

    await this.writeJournal(targets, completed)
    const roots = currentRoots(this.options.getSettings())
    for (const target of targets) {
      const id = targetId(target)
      if (completed.has(id)) continue
      await this.removeTarget(target, roots)
      completed.add(id)
      await this.writeJournal(targets, completed)
    }
    await this.options.deviceLocal.remove(JOURNAL_PATH)
  }

  private async enumerateTargets(): Promise<LearningDataRemovalTarget[]> {
    const { dataRoot, learningRoot } = currentRoots(this.options.getSettings())
    const targets: LearningDataRemovalTarget[] = []
    const projects = this.options.app.vault.getAbstractFileByPath(learningRoot)
    if (projects instanceof TFolder) {
      for (const child of [...projects.children].sort((left, right) =>
        left.path.localeCompare(right.path),
      )) {
        if (
          !(child instanceof TFolder) ||
          child.parent?.path !== learningRoot
        ) {
          continue
        }
        const index = this.options.app.vault.getAbstractFileByPath(
          `${child.path}/index.md`,
        )
        if (!(index instanceof TFile) || index.parent?.path !== child.path) {
          continue
        }
        assertModulePathSegment(child.name, 'Learning project slug')
        targets.push({ kind: 'project', projectSlug: child.name })
      }
    }

    const srsRoot = `${dataRoot}/learning-srs`
    const srsFolder = this.options.app.vault.getAbstractFileByPath(srsRoot)
    if (srsFolder instanceof TFolder) {
      for (const child of [...srsFolder.children].sort((left, right) =>
        left.path.localeCompare(right.path),
      )) {
        if (
          !(child instanceof TFile) ||
          child.parent?.path !== srsRoot ||
          child.extension !== 'json'
        ) {
          continue
        }
        assertModulePathSegment(child.basename, 'Learning project slug')
        targets.push({ kind: 'srs', projectSlug: child.basename })
      }
    }

    const importRoot = `${dataRoot}/anki-import-journals`
    const importFolder =
      this.options.app.vault.getAbstractFileByPath(importRoot)
    if (importFolder instanceof TFolder) {
      for (const child of [...importFolder.children].sort((left, right) =>
        left.path.localeCompare(right.path),
      )) {
        if (!(child instanceof TFile) || child.parent?.path !== importRoot) {
          continue
        }
        const match = UUID.exec(child.basename)
        if (child.extension === 'json' && match) {
          targets.push({ kind: 'anki-import-journal', journalId: match[0] })
        }
      }
    }

    targets.push({ kind: 'settings' })
    if (await this.options.deviceLocal.stat(ANKI_RUNTIME_PATH)) {
      targets.push({ kind: 'anki-runtime' })
    }
    return targets
  }

  private async removeTarget(
    target: LearningDataRemovalTarget,
    roots: LearningRoots,
  ): Promise<void> {
    if (target.kind === 'anki-runtime') {
      await this.options.deviceLocal.remove(ANKI_RUNTIME_PATH)
      return
    }

    const path = targetPath(target, roots)
    const entry = this.options.app.vault.getAbstractFileByPath(path)
    if (!entry) return
    if (target.kind === 'project') {
      const index = this.options.app.vault.getAbstractFileByPath(
        `${path}/index.md`,
      )
      if (
        !(entry instanceof TFolder) ||
        entry.parent?.path !== roots.learningRoot ||
        !(index instanceof TFile) ||
        index.parent?.path !== path
      ) {
        throw new Error(`Learning project path is not canonical: ${path}`)
      }
      await this.options.app.fileManager.trashFile(entry)
      return
    }
    if (!(entry instanceof TFile)) {
      throw new Error(`Exact Learning data path is not a file: ${path}`)
    }
    // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Learning sidecars and settings are the explicit permanent-delete boundary.
    await this.options.app.vault.delete(entry, true)
  }

  private async readJournal(): Promise<LearningDataRemovalJournal | null> {
    if (!(await this.options.deviceLocal.stat(JOURNAL_PATH))) return null
    try {
      return journalSchema.parse(
        JSON.parse(await this.options.deviceLocal.read(JOURNAL_PATH)),
      )
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : ''
      throw new Error(`Learning data removal journal is invalid${detail}`)
    }
  }

  private async writeJournal(
    targets: readonly LearningDataRemovalTarget[],
    completed: ReadonlySet<string>,
  ): Promise<void> {
    if (!(await this.options.deviceLocal.stat(JOURNAL_ROOT))) {
      await this.options.deviceLocal.mkdir(JOURNAL_ROOT)
    }
    const journal: LearningDataRemovalJournal = {
      version: 1,
      targets: [...targets],
      completedTargetIds: targets
        .map(targetId)
        .filter((id) => completed.has(id)),
    }
    await this.options.deviceLocal.write(JOURNAL_PATH, JSON.stringify(journal))
  }
}

type LearningRoots = Readonly<{ dataRoot: string; learningRoot: string }>

function currentRoots(settings: LearningRemovalSettings): LearningRoots {
  return {
    dataRoot: normalizePath(getYoloJsonDbRootDir(settings)),
    learningRoot: normalizePath(getYoloLearningDir(settings)),
  }
}

function targetPath(
  target: Exclude<LearningDataRemovalTarget, { kind: 'anki-runtime' }>,
  roots: LearningRoots,
): string {
  switch (target.kind) {
    case 'project':
      return `${roots.learningRoot}/${target.projectSlug}`
    case 'srs':
      return `${roots.dataRoot}/learning-srs/${target.projectSlug}.json`
    case 'anki-import-journal':
      return `${roots.dataRoot}/anki-import-journals/${target.journalId}.json`
    case 'settings':
      return `${roots.dataRoot}/module-settings/learning.json`
  }
}

function targetId(target: LearningDataRemovalTarget): string {
  switch (target.kind) {
    case 'project':
      return `project:${target.projectSlug}`
    case 'srs':
      return `srs:${target.projectSlug}`
    case 'anki-import-journal':
      return `anki-import-journal:${target.journalId}`
    case 'settings':
      return 'settings'
    case 'anki-runtime':
      return ANKI_RUNTIME_NAMESPACE
  }
}

function validateTargets(targets: readonly LearningDataRemovalTarget[]): void {
  if (targets.length === 0 || targets.length > MAX_TARGETS) {
    throw new Error('Learning data removal target count is invalid')
  }
  const ids = new Set<string>()
  for (const target of targets) {
    if ('projectSlug' in target) {
      assertModulePathSegment(target.projectSlug, 'Learning project slug')
    }
    const id = targetId(target)
    const canonical = id.normalize('NFKC').toLowerCase()
    if (ids.has(canonical)) {
      throw new Error('Learning data removal targets must be unique')
    }
    ids.add(canonical)
  }
}

function validateCompletedTargets(
  targets: readonly LearningDataRemovalTarget[],
  completed: ReadonlySet<string>,
): void {
  const ids = new Set(targets.map(targetId))
  for (const id of completed) {
    if (!ids.has(id)) {
      throw new Error('Learning data removal journal has an unknown target')
    }
  }
}
