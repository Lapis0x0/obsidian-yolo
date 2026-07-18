import { TFile, TFolder } from 'obsidian'

import {
  createLearningOwnedDataDescriptors,
  createLearningOwnedDataRemovalPort,
  isLearningOwnedDataDescriptor,
} from './learningModuleDataRemoval'

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
  const learning = folder('Root/learning')
  const project = folder('Root/learning/React-3', learning)
  const nested = folder('Root/learning/React-3/chapter', project)
  const index = file('Root/learning/React-3/index.md', project)
  const unmanaged = folder('Root/learning/PersonalNotes', learning)
  learning.children.push(project, unmanaged)
  project.children.push(index, nested)
  const srs = folder('Root/.yolo_json_db/learning-srs')
  const srsFile = file('Root/.yolo_json_db/learning-srs/React-3.json', srs)
  const foreignSrs = file('Root/.yolo_json_db/learning-srs/readme.md', srs)
  srs.children.push(srsFile, foreignSrs)
  const journals = folder('Root/.yolo_json_db/anki-import-journals')
  const journal = file(
    'Root/.yolo_json_db/anki-import-journals/123e4567-e89b-42d3-a456-426614174000.json',
    journals,
  )
  const foreignJournal = file(
    'Root/.yolo_json_db/anki-import-journals/notes.json',
    journals,
  )
  journals.children.push(journal, foreignJournal)
  for (const entry of [
    learning,
    project,
    index,
    nested,
    unmanaged,
    srs,
    srsFile,
    foreignSrs,
    journals,
    journal,
    foreignJournal,
  ]) {
    entries.set(entry.path, entry)
  }
  const trashFile = jest.fn(async () => undefined)
  const deleteEntry = jest.fn(async () => undefined)
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
      delete: deleteEntry,
    },
    fileManager: { trashFile },
  }
  return { app, deleteEntry, entries, journal, project, srsFile, trashFile }
}

describe('Learning Host-owned data removal policy', () => {
  it('enumerates only direct canonical owned data and known private state', async () => {
    const value = fixture()
    const descriptors = await createLearningOwnedDataDescriptors(
      value.app as never,
      { yolo: { baseDir: 'Root' } },
      { stat: async () => ({ type: 'folder', size: 0, ctime: 0, mtime: 0 }) },
    )

    expect(descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'learning-canonical-content',
          projectSlug: 'React-3',
          path: value.project.path,
          deletion: 'trash',
        }),
        expect.objectContaining({
          kind: 'learning-srs',
          projectSlug: 'React-3',
          path: value.srsFile.path,
          deletion: 'exact',
        }),
        expect.objectContaining({
          kind: 'learning-import-journal',
          path: value.journal.path,
          deletion: 'exact',
        }),
        expect.objectContaining({
          kind: 'config-document',
          path: 'Root/.yolo_json_db/module-settings/learning.json',
        }),
        expect.objectContaining({
          kind: 'module-private-namespace',
          namespace: 'anki-runtime',
        }),
      ]),
    )
    expect(JSON.stringify(descriptors)).not.toContain('chapter')
    expect(JSON.stringify(descriptors)).not.toContain('PersonalNotes')
    expect(JSON.stringify(descriptors)).not.toContain('readme.md')
    expect(JSON.stringify(descriptors)).not.toContain('notes.json')
  })

  it('trashes project content but permanently deletes exact sidecars', async () => {
    const value = fixture()
    const removePrivate = jest.fn(async () => undefined)
    const port = createLearningOwnedDataRemovalPort(value.app as never, {
      remove: removePrivate,
    })

    await port.remove({
      kind: 'learning-canonical-content',
      moduleId: 'learning',
      projectSlug: 'React-3',
      path: value.project.path,
      deletion: 'trash',
    })
    await port.remove({
      kind: 'learning-srs',
      moduleId: 'learning',
      projectSlug: 'React-3',
      path: value.srsFile.path,
      deletion: 'exact',
    })
    await port.remove({
      kind: 'module-private-namespace',
      moduleId: 'learning',
      locality: 'device-local',
      namespace: 'anki-runtime',
      deletion: 'exact',
    })

    expect(value.trashFile).toHaveBeenCalledWith(value.project)
    expect(value.deleteEntry).toHaveBeenCalledWith(value.srsFile, true)
    expect(removePrivate).toHaveBeenCalledWith(
      'module-private-device-local/learning/anki-runtime',
    )
  })

  it('independently binds approved descriptors to the current managed roots', () => {
    const descriptor = {
      kind: 'learning-srs' as const,
      moduleId: 'learning' as const,
      projectSlug: 'React-3',
      path: 'Root/.yolo_json_db/learning-srs/React-3.json',
      deletion: 'exact' as const,
    }

    expect(
      isLearningOwnedDataDescriptor(descriptor, {
        yolo: { baseDir: 'Root' },
      }),
    ).toBe(true)
    expect(
      isLearningOwnedDataDescriptor(
        {
          ...descriptor,
          path: 'Other/.yolo_json_db/learning-srs/React-3.json',
        },
        { yolo: { baseDir: 'Root' } },
      ),
    ).toBe(false)
  })
})
