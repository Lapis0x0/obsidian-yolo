import { TFile, TFolder } from 'obsidian'

import {
  LearningModuleDataRemovalService,
  type LearningModuleDataRemovalServiceOptions,
} from './learningModuleDataRemoval'
import {
  managedModuleDataNamespace,
  runExclusive,
} from './managedModuleDataLock'

const folder = (path: string, parent: TFolder | null = null): TFolder =>
  Object.assign(new TFolder(), {
    path,
    name: path.split('/').at(-1) ?? '',
    parent,
    children: [],
  })

const file = (path: string, parent: TFolder): TFile => {
  const name = path.split('/').at(-1)!
  const extension = name.includes('.') ? name.split('.').at(-1)! : ''
  return Object.assign(new TFile(), {
    path,
    name,
    basename: extension ? name.slice(0, -(extension.length + 1)) : name,
    extension,
    parent,
  })
}

function fixture() {
  const entries = new Map<string, TFile | TFolder>()
  const local = new Map<string, string | null>()
  let baseDir = 'Root'

  const addTree = (root: string) => {
    const learning = folder(`${root}/learning`)
    const project = folder(`${root}/learning/React-3`, learning)
    const index = file(`${project.path}/index.md`, project)
    learning.children.push(project)
    project.children.push(index)
    const srs = folder(`${root}/.yolo_json_db/learning-srs`)
    const srsFile = file(`${srs.path}/React-3.json`, srs)
    srs.children.push(srsFile)
    const journals = folder(`${root}/.yolo_json_db/anki-import-journals`)
    const journal = file(
      `${journals.path}/123e4567-e89b-42d3-a456-426614174000.json`,
      journals,
    )
    journals.children.push(journal)
    const settings = folder(`${root}/.yolo_json_db/module-settings`)
    const settingsFile = file(`${settings.path}/learning.json`, settings)
    settings.children.push(settingsFile)
    for (const entry of [
      learning,
      project,
      index,
      srs,
      srsFile,
      journals,
      journal,
      settings,
      settingsFile,
    ]) {
      entries.set(entry.path, entry)
    }
    return { journal, project, settingsFile, srsFile }
  }

  const original = addTree(baseDir)
  local.set('module-private-device-local/learning/anki-runtime', null)
  const trashFile = jest.fn(async (entry: TFile | TFolder) => {
    entries.delete(entry.path)
  })
  const deleteEntry = jest.fn(async (entry: TFile | TFolder) => {
    entries.delete(entry.path)
  })
  const events: string[] = []
  const options: LearningModuleDataRemovalServiceOptions = {
    app: {
      vault: {
        getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
        delete: deleteEntry,
      },
      fileManager: { trashFile },
    } as never,
    getSettings: () => ({ yolo: { baseDir } }),
    deviceLocal: {
      mkdir: async (path) => {
        local.set(path, null)
      },
      read: async (path) => {
        const value = local.get(path)
        if (typeof value !== 'string') throw new Error(`Missing ${path}`)
        return value
      },
      remove: async (path) => {
        local.delete(path)
      },
      stat: async (path) =>
        local.has(path)
          ? ({
              type: local.get(path) === null ? 'folder' : 'file',
            } as never)
          : null,
      write: async (path, value) => {
        local.set(path, value)
      },
    },
    intentStore: {
      set: async () => {
        events.push('intent')
        return 'uninstalled'
      },
      get: async () => 'uninstalled',
    },
    artifactUninstaller: {
      uninstall: async () => {
        events.push('artifacts')
      },
    },
    runtime: {
      deactivate: async () => undefined,
      runWithModuleQuiesced: async (_moduleId, operation) => {
        events.push('quiesced')
        return operation()
      },
    },
  }

  return {
    addTree,
    deleteEntry,
    entries,
    events,
    local,
    options,
    original,
    setBaseDir: (value: string) => {
      baseDir = value
    },
    trashFile,
  }
}

describe('LearningModuleDataRemovalService', () => {
  it('uninstalls first, trashes canonical projects, and exactly deletes sidecars', async () => {
    const value = fixture()
    const service = new LearningModuleDataRemovalService(value.options)

    await service.uninstallAndRemoveData()

    expect(value.events).toEqual(['intent', 'artifacts', 'quiesced'])
    expect(value.trashFile).toHaveBeenCalledWith(value.original.project)
    expect(value.deleteEntry).toHaveBeenCalledWith(value.original.srsFile, true)
    expect(value.deleteEntry).toHaveBeenCalledWith(value.original.journal, true)
    expect(value.deleteEntry).toHaveBeenCalledWith(
      value.original.settingsFile,
      true,
    )
    expect(value.local.has('module-data-removal-journals/learning.json')).toBe(
      false,
    )
    expect(
      value.local.has('module-private-device-local/learning/anki-runtime'),
    ).toBe(false)
  })

  it('keeps a logical journal after failure and resumes against the current baseDir', async () => {
    const value = fixture()
    let failed = false
    const resumedDelete = jest.fn(async (entry: TFile) => {
      if (entry.path.endsWith('/learning-srs/React-3.json') && !failed) {
        failed = true
        throw new Error('SRS removal failed')
      }
      value.entries.delete(entry.path)
    })
    value.options.app.vault.delete = resumedDelete
    const service = new LearningModuleDataRemovalService(value.options)

    await expect(service.uninstallAndRemoveData()).rejects.toThrow(
      'SRS removal failed',
    )
    const journal = JSON.parse(
      value.local.get('module-data-removal-journals/learning.json') as string,
    )
    expect(journal.targets[0]).toEqual({
      kind: 'project',
      projectSlug: 'React-3',
    })
    expect(JSON.stringify(journal)).not.toContain('Root/learning')

    value.setBaseDir('Moved')
    const moved = value.addTree('Moved')
    await service.uninstallAndRemoveData()

    expect(resumedDelete).toHaveBeenCalledWith(moved.srsFile, true)
    expect(value.local.has('module-data-removal-journals/learning.json')).toBe(
      false,
    )
  })

  it('fails closed when an exact target resolves to the wrong file type', async () => {
    const value = fixture()
    const wrong = folder('Root/.yolo_json_db/module-settings/learning.json')
    value.entries.set(wrong.path, wrong)

    await expect(
      new LearningModuleDataRemovalService(
        value.options,
      ).uninstallAndRemoveData(),
    ).rejects.toThrow('not a file')
    expect(value.local.has('module-data-removal-journals/learning.json')).toBe(
      true,
    )
  })

  it('holds the shared managed-data lock for the complete deletion plan', async () => {
    const value = fixture()
    let releaseDelete!: () => void
    const blockedDelete = new Promise<void>((resolve) => {
      releaseDelete = resolve
    })
    const originalDelete = value.options.app.vault.delete.bind(
      value.options.app.vault,
    )
    value.options.app.vault.delete = jest.fn(async (entry: TFile) => {
      if (entry.path.endsWith('/learning-srs/React-3.json')) {
        await blockedDelete
      }
      await originalDelete(entry, true)
    })
    const service = new LearningModuleDataRemovalService(value.options)
    const removal = service.uninstallAndRemoveData()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    const competing = jest.fn(async () => undefined)
    const queued = runExclusive(
      value.options.app.vault,
      managedModuleDataNamespace('learning', 'managed-data'),
      competing,
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(competing).not.toHaveBeenCalled()

    releaseDelete()
    await removal
    await queued
    expect(competing).toHaveBeenCalledTimes(1)
  })
})
