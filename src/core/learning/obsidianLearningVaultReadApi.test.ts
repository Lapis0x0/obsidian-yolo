import { TFile } from 'obsidian'
import type { App } from 'obsidian'

import { createObsidianLearningVaultReadApi } from './obsidianLearningVaultReadApi'

describe('Obsidian Learning vault read adapter', () => {
  it('checks existence and reads binary data with normalized paths', async () => {
    const bytes = new ArrayBuffer(2)
    const adapter = {
      exists: jest.fn(async () => true),
      readBinary: jest.fn(async () => bytes),
    }
    const app = {
      vault: {
        adapter,
        getAbstractFileByPath: jest.fn(() => null),
        getMarkdownFiles: jest.fn(() => []),
        on: jest.fn(),
        offref: jest.fn(),
      },
    } as unknown as App
    const api = createObsidianLearningVaultReadApi(app)

    await expect(api.exists('/p//asset.bin/')).resolves.toBe(true)
    await expect(api.readBinary('/p//asset.bin/')).resolves.toBe(bytes)
    expect(adapter.exists).toHaveBeenCalledWith('p/asset.bin')
    expect(adapter.readBinary).toHaveBeenCalledWith('p/asset.bin')
  })

  it('continues to read text through a vault file identity', async () => {
    const file = new TFile()
    file.path = 'p/file.md'
    const app = {
      vault: {
        adapter: {},
        getAbstractFileByPath: jest.fn(() => file),
        cachedRead: jest.fn(async () => 'content'),
        getMarkdownFiles: jest.fn(() => []),
        on: jest.fn(),
        offref: jest.fn(),
      },
    } as unknown as App

    await expect(
      createObsidianLearningVaultReadApi(app).readText('p/file.md'),
    ).resolves.toBe('content')
  })
})
