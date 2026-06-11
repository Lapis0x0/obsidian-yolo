jest.mock('../skills/liteSkills', () => ({
  listLiteSkillEntries: jest.fn(async () => [
    {
      name: 'skill-creator',
      description: 'Create skills',
      mode: 'lazy',
      path: 'builtin://skills/skill-creator',
    },
  ]),
}))

import { TFile, TFolder } from 'obsidian'

import { resolveAgentApiContext } from './agent-api-context'

function createMockFile(path: string): InstanceType<typeof TFile> {
  const extension = path.split('.').pop() ?? ''
  return Object.assign(new TFile(), {
    path,
    extension,
  })
}

function createMockFolder(path: string): InstanceType<typeof TFolder> {
  return Object.assign(new TFolder(), {
    path,
    children: [],
  })
}

describe('resolveAgentApiContext', () => {
  it('resolves files, folders, skills, and dedupes them', async () => {
    const file = createMockFile('Daily/2026-05-29.md')
    const folder = createMockFolder('Projects/YOLO')
    const app = {
      vault: {
        getFileByPath: jest.fn((path: string) =>
          path === file.path ? file : null,
        ),
        getFolderByPath: jest.fn((path: string) =>
          path === folder.path ? folder : null,
        ),
      },
    } as unknown as import('obsidian').App

    const resolved = await resolveAgentApiContext({
      app,
      settings: {} as any,
      context: [
        { type: 'file', path: 'Daily/2026-05-29.md' },
        { type: 'file', path: 'Daily/2026-05-29.md' },
        { type: 'folder', path: 'Projects/YOLO' },
        { type: 'folder', path: 'Projects/YOLO' },
        { type: 'skill', name: 'skill-creator' },
        { type: 'skill', name: 'skill-creator' },
        { type: 'text', content: 'plain text' },
      ],
    })

    expect(resolved.mentionables).toEqual([
      { type: 'file', file },
      { type: 'folder', folder },
    ])
    expect(resolved.selectedSkills).toEqual([
      {
        name: 'skill-creator',
        description: 'Create skills',
        path: 'builtin://skills/skill-creator',
      },
    ])
    expect(resolved.textBlocks).toEqual([
      { type: 'text', content: 'plain text' },
    ])
  })

  it('throws when file, folder, or skill does not exist', async () => {
    const app = {
      vault: {
        getFileByPath: jest.fn(() => null),
        getFolderByPath: jest.fn(() => null),
      },
    } as unknown as import('obsidian').App

    await expect(
      resolveAgentApiContext({
        app,
        settings: {} as any,
        context: [{ type: 'file', path: 'missing.md' }],
      }),
    ).rejects.toThrow('Agent context file not found: missing.md')

    await expect(
      resolveAgentApiContext({
        app,
        settings: {} as any,
        context: [{ type: 'folder', path: 'missing-folder' }],
      }),
    ).rejects.toThrow('Agent context folder not found: missing-folder')

    await expect(
      resolveAgentApiContext({
        app,
        settings: {} as any,
        context: [{ type: 'skill', name: 'missing-skill' }],
      }),
    ).rejects.toThrow('Agent context skill not found: missing-skill')
  })
})
