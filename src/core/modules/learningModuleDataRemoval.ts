import { type App, TFile, TFolder, normalizePath } from 'obsidian'

import { getYoloJsonDbRootDir, getYoloLearningDir } from '../paths/yoloPaths'

import type { IndexedDbDataAdapter } from './indexedDbDataAdapter'
import type {
  ModuleDataRemovalJournal,
  ModuleDataRemovalJournalPort,
  ModuleOwnedDataDescriptor,
  ModuleOwnedDataRemovalPort,
} from './moduleDataRemovalCoordinator'
import { assertModulePathSegment } from './moduleStore'

const LEARNING_MODULE_ID = 'learning'
const ANKI_RUNTIME_NAMESPACE = 'anki-runtime'
const JOURNAL_ROOT = 'module-data-removal-journals'
const UUID_JSON =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/

type LearningRemovalSettings = Readonly<{
  yolo?: Readonly<{ baseDir?: string }>
}>

export async function createLearningOwnedDataDescriptors(
  app: App,
  settings: LearningRemovalSettings,
  deviceLocal: Pick<IndexedDbDataAdapter, 'stat'>,
): Promise<readonly ModuleOwnedDataDescriptor[]> {
  const learningRoot = normalizePath(getYoloLearningDir(settings))
  const dataRoot = normalizePath(getYoloJsonDbRootDir(settings))
  const descriptors: ModuleOwnedDataDescriptor[] = []
  const projects = app.vault.getAbstractFileByPath(learningRoot)
  if (projects instanceof TFolder) {
    for (const child of [...projects.children].sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      if (!(child instanceof TFolder) || child.parent?.path !== learningRoot) {
        continue
      }
      const index = app.vault.getAbstractFileByPath(`${child.path}/index.md`)
      if (!(index instanceof TFile) || index.parent?.path !== child.path)
        continue
      assertModulePathSegment(child.name, 'Learning project slug')
      descriptors.push({
        kind: 'learning-canonical-content',
        moduleId: LEARNING_MODULE_ID,
        projectSlug: child.name,
        path: child.path,
        deletion: 'trash',
      })
    }
  }

  const srsRoot = `${dataRoot}/learning-srs`
  const srsFolder = app.vault.getAbstractFileByPath(srsRoot)
  if (srsFolder instanceof TFolder) {
    for (const child of [...srsFolder.children].sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      if (!(child instanceof TFile) || child.parent?.path !== srsRoot) continue
      if (child.extension !== 'json') continue
      assertModulePathSegment(child.basename, 'Learning project slug')
      descriptors.push({
        kind: 'learning-srs',
        moduleId: LEARNING_MODULE_ID,
        projectSlug: child.basename,
        path: child.path,
        deletion: 'exact',
      })
    }
  }

  const importRoot = `${dataRoot}/anki-import-journals`
  const importFolder = app.vault.getAbstractFileByPath(importRoot)
  if (importFolder instanceof TFolder) {
    for (const child of [...importFolder.children].sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      if (!(child instanceof TFile) || child.parent?.path !== importRoot)
        continue
      const match = UUID_JSON.exec(child.name)
      if (!match) continue
      descriptors.push({
        kind: 'learning-import-journal',
        moduleId: LEARNING_MODULE_ID,
        journalId: match[1],
        path: child.path,
        deletion: 'exact',
      })
    }
  }

  descriptors.push({
    kind: 'config-document',
    moduleId: LEARNING_MODULE_ID,
    documentId: 'settings',
    path: `${dataRoot}/module-settings/learning.json`,
    deletion: 'exact',
  })
  if (
    await deviceLocal.stat(
      `module-private-device-local/learning/${ANKI_RUNTIME_NAMESPACE}`,
    )
  ) {
    descriptors.push({
      kind: 'module-private-namespace',
      moduleId: LEARNING_MODULE_ID,
      locality: 'device-local',
      namespace: ANKI_RUNTIME_NAMESPACE,
      deletion: 'exact',
    })
  }
  return Object.freeze(descriptors)
}

export function isLearningOwnedDataDescriptor(
  descriptor: ModuleOwnedDataDescriptor,
  settings: LearningRemovalSettings,
): boolean {
  if (descriptor.moduleId !== LEARNING_MODULE_ID) return false
  const learningRoot = normalizePath(getYoloLearningDir(settings))
  const dataRoot = normalizePath(getYoloJsonDbRootDir(settings))
  switch (descriptor.kind) {
    case 'learning-canonical-content':
      return descriptor.path === `${learningRoot}/${descriptor.projectSlug}`
    case 'learning-srs':
      return (
        descriptor.path ===
        `${dataRoot}/learning-srs/${descriptor.projectSlug}.json`
      )
    case 'learning-import-journal':
      return (
        descriptor.path ===
        `${dataRoot}/anki-import-journals/${descriptor.journalId}.json`
      )
    case 'config-document':
      return (
        descriptor.documentId === 'settings' &&
        descriptor.path === `${dataRoot}/module-settings/learning.json`
      )
    case 'module-private-namespace':
      return (
        descriptor.locality === 'device-local' &&
        descriptor.namespace === ANKI_RUNTIME_NAMESPACE
      )
  }
}

export function createLearningOwnedDataRemovalPort(
  app: App,
  deviceLocal: Pick<IndexedDbDataAdapter, 'remove'>,
): ModuleOwnedDataRemovalPort {
  return Object.freeze({
    remove: async (descriptor) => {
      if (descriptor.moduleId !== LEARNING_MODULE_ID) {
        throw new Error('Learning removal port rejects foreign module data')
      }
      if (descriptor.kind === 'learning-canonical-content') {
        const entry = app.vault.getAbstractFileByPath(descriptor.path)
        if (entry) await app.fileManager.trashFile(entry)
        return
      }
      if (
        descriptor.kind === 'learning-srs' ||
        descriptor.kind === 'learning-import-journal' ||
        descriptor.kind === 'config-document'
      ) {
        const entry = app.vault.getAbstractFileByPath(descriptor.path)
        if (!entry) return
        if (!(entry instanceof TFile)) {
          throw new Error(
            `Exact Learning data path is not a file: ${descriptor.path}`,
          )
        }
        // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Sidecars/config use the protocol's exact permanent-delete boundary.
        await app.vault.delete(entry, true)
        return
      }
      if (
        descriptor.kind === 'module-private-namespace' &&
        descriptor.locality === 'device-local'
      ) {
        await deviceLocal.remove(
          `module-private-device-local/learning/${descriptor.namespace}`,
        )
        return
      }
      throw new Error('Learning removal port rejects unsupported data')
    },
  })
}

export function createModuleDataRemovalJournalPort(
  adapter: Pick<
    IndexedDbDataAdapter,
    'mkdir' | 'read' | 'remove' | 'stat' | 'write'
  >,
): ModuleDataRemovalJournalPort {
  const pathFor = (moduleId: string): string =>
    `${JOURNAL_ROOT}/${moduleId}.json`
  return Object.freeze({
    read: async (moduleId) => {
      const path = pathFor(moduleId)
      return (await adapter.stat(path))
        ? JSON.parse(await adapter.read(path))
        : null
    },
    write: async (moduleId, journal: ModuleDataRemovalJournal) => {
      if (!(await adapter.stat(JOURNAL_ROOT))) await adapter.mkdir(JOURNAL_ROOT)
      await adapter.write(pathFor(moduleId), JSON.stringify(journal))
    },
    remove: (moduleId) => adapter.remove(pathFor(moduleId)),
  })
}
