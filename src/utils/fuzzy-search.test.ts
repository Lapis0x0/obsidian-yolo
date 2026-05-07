jest.mock('obsidian', () => {
  class TFile {}
  class TFolder {}
  class App {}

  return {
    App,
    TFile,
    TFolder,
    MarkdownView: class {},
  }
})

import { App, TFile, TFolder } from 'obsidian'

import type { MentionableFile } from '../types/mentionable'

import { fuzzySearchFiles } from './fuzzy-search'

function createFile(path: string): TFile {
  return Object.assign(new TFile(), {
    path,
    name: path.split('/').pop() ?? path,
    basename: (path.split('/').pop() ?? path).replace(/\.[^.]+$/, ''),
    extension: path.split('.').pop() ?? '',
    stat: {
      ctime: 0,
      mtime: 0,
      size: 0,
    },
  })
}

function createFolder(path: string): TFolder {
  return Object.assign(new TFolder(), {
    path,
    name: path.split('/').pop() ?? path,
    children: [],
  })
}

describe('fuzzySearchFiles', () => {
  it('returns file suggestions for empty query without depending on folder results', () => {
    const files = [
      createFile('notes/alpha.md'),
      createFile('notes/beta.md'),
      createFile('assets/image.png'),
    ]
    const folders = Array.from({ length: 30 }, (_, index) =>
      createFolder(`folder-${index + 1}`),
    )

    const app = Object.assign(new App(), {
      vault: {
        getFiles: () => files,
        getAllFolders: () => folders,
      },
      workspace: {
        getActiveFile: () => null,
        getLeavesOfType: () => [],
      },
    })

    expect(
      fuzzySearchFiles(app, '').map((entry: MentionableFile) => entry.file.path),
    ).toEqual(['notes/alpha.md', 'notes/beta.md', 'assets/image.png'])
  })
})
