jest.mock('obsidian')

import { App, TFile, TFolder } from 'obsidian'

import {
  MENTION_SEARCHABLE_EXTENSIONS,
  fuzzySearch,
  fuzzySearchFolders,
} from './fuzzy-search'

describe('MENTION_SEARCHABLE_EXTENSIONS', () => {
  it('includes conservative text formats for @ file mentions', () => {
    for (const extension of ['canvas', 'base', 'json', 'yaml', 'yml', 'txt']) {
      expect(MENTION_SEARCHABLE_EXTENSIONS.has(extension)).toBe(true)
    }
  })
})

const makeFile = (path: string): TFile => {
  const parts = path.split('/')
  const name = parts[parts.length - 1]
  return Object.assign(new TFile(), {
    path,
    name,
    extension: name.split('.').pop() ?? '',
    stat: { mtime: Date.now(), ctime: Date.now(), size: 10 },
  })
}

const makeFolder = (path: string): TFolder => {
  const parts = path.split('/')
  return Object.assign(new TFolder(), {
    path,
    name: parts[parts.length - 1],
  })
}

function makeApp(files: TFile[], folders: TFolder[]): App {
  return {
    workspace: {
      getActiveFile: jest.fn().mockReturnValue(null),
      getLeavesOfType: jest.fn().mockReturnValue([]),
    },
    vault: {
      getFiles: jest.fn().mockReturnValue(files),
      getAllFolders: jest.fn().mockReturnValue(folders),
    },
  } as unknown as App
}

describe('fuzzySearch / fuzzySearchFolders (YOLO user data root exclusion)', () => {
  const settings = { yolo: { baseDir: 'YOLO' } }

  it('excludes files under the visible user data root from the mention picker', () => {
    const chatFile = makeFile('YOLO/data/chats/v1_abc.json')
    const noteFile = makeFile('Notes/todo.md')
    const app = makeApp([chatFile, noteFile], [])

    const results = fuzzySearch(app, '', settings)

    expect(
      results.some(
        (item) => item.type === 'file' && item.file.path === noteFile.path,
      ),
    ).toBe(true)
    expect(
      results.some(
        (item) => item.type === 'file' && item.file.path === chatFile.path,
      ),
    ).toBe(false)
  })

  it('excludes folders under the visible user data root from folder search', () => {
    const dataFolder = makeFolder('YOLO/data')
    const projectFolder = makeFolder('Projects')
    const app = makeApp([], [dataFolder, projectFolder])

    const results = fuzzySearchFolders(app, '', settings)

    expect(results.map((item) => item.folder.path)).toEqual([
      projectFolder.path,
    ])
  })

  it('does not filter anything when settings are omitted from an unrelated root', () => {
    const noteFile = makeFile('Notes/todo.md')
    const app = makeApp([noteFile], [])

    const results = fuzzySearch(app, '')

    expect(results.some((item) => item.type === 'file')).toBe(true)
  })
})

// D3 of docs/plans/09-03-whiteboard-agent-tools/master.md: `.yoloboard` isn't
// (and shouldn't be — this is a general host utility with no import of
// core/modules) in the static MENTION_SEARCHABLE_EXTENSIONS list, so a module
// that's claimed a file-text renderer for it is unioned in per call instead.
describe('fuzzySearch extraSearchableExtensions (D3)', () => {
  it('excludes a module-owned extension by default', () => {
    const boardFile = makeFile('Boards/Reading Notes.yoloboard')
    const app = makeApp([boardFile], [])

    const results = fuzzySearch(app, '')

    expect(
      results.some(
        (item) => item.type === 'file' && item.file.path === boardFile.path,
      ),
    ).toBe(false)
  })

  it('includes a module-owned extension when passed as extraSearchableExtensions', () => {
    const boardFile = makeFile('Boards/Reading Notes.yoloboard')
    const noteFile = makeFile('Notes/todo.md')
    const app = makeApp([boardFile, noteFile], [])

    const results = fuzzySearch(app, '', undefined, ['yoloboard'])

    expect(
      results.some(
        (item) => item.type === 'file' && item.file.path === boardFile.path,
      ),
    ).toBe(true)
    expect(
      results.some(
        (item) => item.type === 'file' && item.file.path === noteFile.path,
      ),
    ).toBe(true)
  })

  it('does not mutate the shared MENTION_SEARCHABLE_EXTENSIONS constant', () => {
    const boardFile = makeFile('Boards/Reading Notes.yoloboard')
    const app = makeApp([boardFile], [])

    fuzzySearch(app, '', undefined, ['yoloboard'])

    expect(MENTION_SEARCHABLE_EXTENSIONS.has('yoloboard')).toBe(false)
  })
})
