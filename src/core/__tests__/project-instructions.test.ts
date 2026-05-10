import { App, TFile } from 'obsidian'

import { getProjectInstructionsSection } from '../project-instructions'

type FileMap = Record<string, string>

function createApp(files: FileMap): App {
  const getAbstractFileByPath = jest.fn((path: string) => {
    if (!(path in files)) return null
    const file = new (TFile as unknown as new () => TFile)()
    ;(file as unknown as { path: string }).path = path
    return file
  })

  const cachedRead = jest.fn(async (file: TFile) => {
    const path = (file as unknown as { path: string }).path
    return files[path] ?? ''
  })

  return {
    vault: { getAbstractFileByPath, cachedRead },
  } as unknown as App
}

describe('getProjectInstructionsSection', () => {
  it('returns empty string when disabled', async () => {
    const app = createApp({ 'CLAUDE.md': 'do the thing' })
    expect(await getProjectInstructionsSection(app, false)).toBe('')
  })

  it('returns empty string when no instruction files exist', async () => {
    const app = createApp({})
    expect(await getProjectInstructionsSection(app, true)).toBe('')
  })

  it('includes CLAUDE.md content when present', async () => {
    const app = createApp({ 'CLAUDE.md': 'use 2-space indent' })
    const result = await getProjectInstructionsSection(app, true)
    expect(result).toContain('## CLAUDE.md')
    expect(result).toContain('use 2-space indent')
  })

  it('includes AGENTS.md content when present', async () => {
    const app = createApp({ 'AGENTS.md': 'follow the contract' })
    const result = await getProjectInstructionsSection(app, true)
    expect(result).toContain('## AGENTS.md')
    expect(result).toContain('follow the contract')
  })

  it('concatenates both files with AGENTS.md first', async () => {
    const app = createApp({
      'AGENTS.md': 'rule A',
      'CLAUDE.md': 'rule C',
    })
    const result = await getProjectInstructionsSection(app, true)
    const agentsIdx = result.indexOf('## AGENTS.md')
    const claudeIdx = result.indexOf('## CLAUDE.md')
    expect(agentsIdx).toBeGreaterThan(-1)
    expect(claudeIdx).toBeGreaterThan(-1)
    expect(agentsIdx).toBeLessThan(claudeIdx)
    expect(result).toContain('rule A')
    expect(result).toContain('rule C')
  })

  it('skips empty files', async () => {
    const app = createApp({
      'AGENTS.md': '   \n  ',
      'CLAUDE.md': 'real content',
    })
    const result = await getProjectInstructionsSection(app, true)
    expect(result).not.toContain('## AGENTS.md')
    expect(result).toContain('## CLAUDE.md')
  })

  it('does not authorize override of system safety', async () => {
    const app = createApp({ 'CLAUDE.md': 'rule' })
    const result = await getProjectInstructionsSection(app, true)
    expect(result.toLowerCase()).not.toMatch(/override.*default/)
    expect(result.toLowerCase()).not.toMatch(/must follow.*exactly/)
  })
})
