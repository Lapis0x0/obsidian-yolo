import type { App } from 'obsidian'

import type { TtsSynthesisFileResult } from '../../../../core/tts/types'
import type { TtsConfig } from '../../../../settings/schema/setting.types'

import {
  GeneratedAudioStore,
  normalizeVaultRelativeDir,
} from './generatedAudioStore'

describe('generated audio store paths', () => {
  it('accepts vault-relative directories', () => {
    expect(normalizeVaultRelativeDir(' Read Aloud/2026 ')).toBe(
      'Read Aloud/2026',
    )
  })

  it('rejects absolute and parent-traversal directories', () => {
    expect(() => normalizeVaultRelativeDir('/tmp/read-aloud')).toThrow(
      /vault-relative/i,
    )
    expect(() => normalizeVaultRelativeDir('C:/tmp/read-aloud')).toThrow(
      /vault-relative/i,
    )
    expect(() => normalizeVaultRelativeDir('../outside')).toThrow(/\.\./)
  })

  it('keeps multi-segment auto-save stable when segments finish together', async () => {
    const { app, files, vault } = createMockApp()
    const store = new GeneratedAudioStore(app)
    const session = store.createSession({
      saveDir: 'YOLO/read_aloud',
      sourceName: 'selection',
      sourcePath: 'note.md',
      totalSegments: 2,
      ttsConfig: { id: 'tts', name: 'TTS', model: 'model' } as TtsConfig,
    })
    const audio = createAudioResult()

    const paths = await Promise.all([
      store.saveSegment({ session, segmentIndex: 0, audio }),
      store.saveSegment({ session, segmentIndex: 1, audio }),
    ])

    expect(paths[0]).toMatch(/\/001\.mp3$/)
    expect(paths[1]).toMatch(/\/002\.mp3$/)
    const indexPath = `${session.rootDir}/index.md`
    expect(files.has(indexPath)).toBe(true)
    expect(vault.adapter.write).toHaveBeenCalledWith(
      indexPath,
      expect.stringContaining(`[[${paths[1]}]]`),
    )
  })
})

const createAudioResult = (): TtsSynthesisFileResult => ({
  kind: 'file',
  bytes: new Uint8Array([1, 2, 3]).buffer,
  mimeType: 'audio/mpeg',
  format: 'mp3',
})

const createMockApp = (): {
  app: App
  files: Map<string, string | ArrayBuffer>
  vault: {
    adapter: {
      exists: jest.Mock<Promise<boolean>, [string]>
      write: jest.Mock<Promise<void>, [string, string]>
    }
    createFolder: jest.Mock<Promise<void>, [string]>
    createBinary: jest.Mock<Promise<void>, [string, ArrayBuffer]>
    create: jest.Mock<Promise<void>, [string, string]>
    getAbstractFileByPath: jest.Mock<unknown, [string]>
  }
} => {
  const dirs = new Set<string>()
  const files = new Map<string, string | ArrayBuffer>()
  const adapter = {
    exists: jest.fn(async (path: string) => dirs.has(path) || files.has(path)),
    write: jest.fn(async (path: string, content: string) => {
      files.set(path, content)
    }),
  }
  const vault = {
    adapter,
    createFolder: jest.fn(async (path: string) => {
      if (dirs.has(path)) throw new Error(`Folder exists: ${path}`)
      dirs.add(path)
    }),
    createBinary: jest.fn(async (path: string, bytes: ArrayBuffer) => {
      if (files.has(path)) throw new Error(`File exists: ${path}`)
      files.set(path, bytes)
    }),
    create: jest.fn(async (path: string, content: string) => {
      if (files.has(path)) throw new Error(`File exists: ${path}`)
      files.set(path, content)
    }),
    // Force the race path for index.md: both writers believe it is missing,
    // so the second one must recover from create() seeing the existing file.
    getAbstractFileByPath: jest.fn((path: string) =>
      path.endsWith('/index.md') ? null : files.has(path) ? {} : null,
    ),
  }
  return { app: { vault } as unknown as App, files, vault }
}
