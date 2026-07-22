// eslint-disable-next-line import/no-nodejs-modules -- tests use Node Web Crypto for SHA-256 verification
import { createHash, webcrypto } from 'node:crypto'

import type { RequestUrlResponse } from 'obsidian'

import type { ModuleService } from '../modules/moduleService'

import {
  ModuleUpdateController,
  fetchModuleReleaseNotes,
} from './moduleUpdateController'

const note =
  '## 1.1.0 Learning update\n\n- Better reviews\n\n---\n\n## 1.1.0 学习模式更新\n\n- 优化复习\n'
const noteBytes = new TextEncoder().encode(note)
const descriptor = {
  url: 'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv1.1.0/release-note.md',
  byteSize: noteBytes.byteLength,
  sha256: createHash('sha256').update(noteBytes).digest('hex'),
}

const response = (bytes: Uint8Array): RequestUrlResponse => ({
  status: 200,
  headers: {},
  text: new TextDecoder().decode(bytes),
  arrayBuffer: bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ),
  json: null,
})

function service(): jest.Mocked<ModuleService> {
  const candidate = {
    moduleId: 'learning',
    expectedVersion: '1.1.0',
    expectedManifestSha256: 'a'.repeat(64),
  }
  return {
    getSnapshot: jest.fn(() => ({
      status: 'ready',
      errors: {},
      modules: [
        {
          id: 'learning',
          name: 'Learning',
          description: '',
          version: '1.0.0',
          status: 'update-available',
          enabled: true,
          desiredInstalled: true,
          installed: { id: 'learning', version: '1.0.0', active: true },
          catalog: {
            id: 'learning',
            version: '1.1.0',
            releaseNotes: descriptor,
          },
        },
      ],
    })),
    subscribe: jest.fn(() => () => undefined),
    refresh: jest.fn(async () => undefined),
    checkForUpdates: jest.fn(async () => undefined),
    getInstallCandidate: jest.fn(() => candidate),
    prepare: jest.fn(async (_candidate, onProgress) => {
      onProgress?.(50)
      onProgress?.(100)
      return { version: '1.1.0' }
    }),
    install: jest.fn(async () => ({ version: '1.1.0' })),
    setEnabled: jest.fn(async () => ({})),
    uninstall: jest.fn(async () => ({})),
    start: jest.fn(async () => undefined),
    getVerifiedArtifact: jest.fn(() => undefined),
    dispose: jest.fn(),
  } as unknown as jest.Mocked<ModuleService>
}

describe('module update controller', () => {
  it('verifies and parses an immutable bilingual release note', async () => {
    await expect(
      fetchModuleReleaseNotes({
        descriptor,
        version: '1.1.0',
        request: jest.fn(async () => response(noteBytes)),
        subtleCrypto: webcrypto.subtle as unknown as SubtleCrypto,
      }),
    ).resolves.toEqual({
      en: '## 1.1.0 Learning update\n\n- Better reviews',
      zh: '## 1.1.0 学习模式更新\n\n- 优化复习',
    })
  })

  it('prepares without installing, then applies only after confirmation', async () => {
    jest.useFakeTimers()
    const moduleService = service()
    const controller = new ModuleUpdateController({
      service: moduleService,
      getAutoDownloadEnabled: () => true,
      getMutedVersions: () => ({}),
      muteVersion: jest.fn(async () => undefined),
      request: jest.fn(async () => response(noteBytes)),
      subtleCrypto: webcrypto.subtle as unknown as SubtleCrypto,
    })

    await controller.refresh()
    await Promise.resolve()
    await Promise.resolve()
    expect(moduleService.prepare).toHaveBeenCalledTimes(1)
    expect(moduleService.install).not.toHaveBeenCalled()

    const key = controller.getSnapshot()[0]?.key
    expect(key).toBe('learning@1.1.0')
    await controller.update(key)
    expect(moduleService.install).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()[0]?.status).toBe('success')

    jest.advanceTimersByTime(1_500)
    expect(controller.getSnapshot()).toEqual([])
    controller.dispose()
    jest.useRealTimers()
  })

  it('does not prompt for a muted module version', async () => {
    const controller = new ModuleUpdateController({
      service: service(),
      getAutoDownloadEnabled: () => false,
      getMutedVersions: () => ({ learning: '1.1.0' }),
      muteVersion: jest.fn(async () => undefined),
    })

    await controller.refresh()
    expect(controller.getSnapshot()).toEqual([])
  })
})
