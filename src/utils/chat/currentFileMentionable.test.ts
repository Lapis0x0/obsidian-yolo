import type { TFile } from 'obsidian'

import type { Mentionable } from '../../types/mentionable'
import {
  getDisplayOnlyCurrentFileMentionables,
  getLatestValidCurrentFileMentionable,
  normalizeMentionablesWithAutoCurrentFile,
} from './currentFileMentionable'

const createMockFile = (path: string): TFile =>
  ({
    path,
    name: path.split('/').pop() ?? path,
  }) as TFile

describe('currentFileMentionable helpers', () => {
  it('returns only auto-attached current-file mentionables that are display-only', () => {
    const activeFile = createMockFile('notes/current.md')
    const manualFile = createMockFile('notes/manual.md')
    const mentionables: Mentionable[] = [{ type: 'file', file: manualFile }]
    const displayMentionables: Mentionable[] = [
      { type: 'current-file', file: activeFile },
      ...mentionables,
    ]

    expect(
      getDisplayOnlyCurrentFileMentionables(mentionables, displayMentionables),
    ).toEqual([{ type: 'current-file', file: activeFile }])
  })

  it('replaces stale current-file mentionables with the latest active file', () => {
    const staleFile = createMockFile('notes/old.md')
    const activeFile = createMockFile('notes/new.md')
    const manualFile = createMockFile('notes/manual.md')
    const mentionables: Mentionable[] = [
      { type: 'current-file', file: staleFile },
      { type: 'file', file: manualFile },
    ]

    expect(
      normalizeMentionablesWithAutoCurrentFile(mentionables, activeFile, true),
    ).toEqual([
      { type: 'current-file', file: activeFile },
      { type: 'file', file: manualFile },
    ])
  })

  it('keeps manual file mentions while dropping auto current-file mentions when auto attach is off', () => {
    const staleFile = createMockFile('notes/old.md')
    const manualFile = createMockFile('notes/manual.md')
    const mentionables: Mentionable[] = [
      { type: 'current-file', file: staleFile },
      { type: 'file', file: manualFile },
    ]

    expect(
      normalizeMentionablesWithAutoCurrentFile(mentionables, null, false),
    ).toEqual([{ type: 'file', file: manualFile }])
  })

  it('picks only the last valid current-file mentionable from polluted history', () => {
    const firstFile = createMockFile('notes/first.md')
    const latestFile = createMockFile('notes/latest.md')
    const mentionables: Mentionable[] = [
      { type: 'current-file', file: firstFile },
      { type: 'current-file', file: null },
      { type: 'current-file', file: latestFile },
    ]

    expect(getLatestValidCurrentFileMentionable(mentionables)).toBe(latestFile)
  })
})
