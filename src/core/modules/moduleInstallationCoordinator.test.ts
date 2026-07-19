import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type { ModuleDeviceState } from './moduleDeviceStateStore'
import { ModuleInstallationCoordinator } from './moduleInstallationCoordinator'

const HASH = 'a'.repeat(64)
const candidate = {
  moduleId: 'learning',
  expectedVersion: '2.0.0',
  expectedManifestSha256: HASH,
}

function descriptor(): ModuleArtifactDescriptor {
  return {
    id: 'learning',
    version: '2.0.0',
    hostApi: '^1.0.0',
    platform: 'desktop',
    dataSchemas: {},
    manifestUrl:
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning-v2.0.0/module.json',
    manifest: { byteSize: 1, sha256: HASH },
  }
}

function harness(initial: ModuleDeviceState | null = null) {
  let durable = initial
  const value = new ModuleInstallationCoordinator({
    catalogSource: { getResolvedArtifactDescriptor: () => descriptor() },
    installer: {
      install: async () => ({
        schemaVersion: 1,
        id: 'learning',
        version: '2.0.0',
        hostApi: '^1.0.0',
        dataSchemas: {},
        variants: [{ platform: 'desktop', entry: 'main.js', files: [] }],
      }),
    },
    deviceStateStore: {
      runExclusive: async (_moduleId, operation) =>
        operation({
          read: async () => durable,
          write: async (next) => {
            durable = next
            return next
          },
          remove: async () => {
            durable = null
          },
        }),
    },
    manager: { refresh: async () => undefined },
    platform: 'desktop',
  })
  return { value, durable: () => durable }
}

describe('ModuleInstallationCoordinator', () => {
  test('downloads and directly schedules the confirmed version', async () => {
    const test = harness()
    await expect(
      test.value.installConfirmedCandidate(candidate),
    ).resolves.toMatchObject({
      state: {
        active: null,
        pending: {
          descriptor: { version: '2.0.0' },
        },
      },
    })
    expect(test.durable()).toMatchObject({
      active: null,
      pending: {
        descriptor: { version: '2.0.0' },
      },
    })
  })

  test('replaces an older pending target', async () => {
    const older = descriptor()
    const second = harness({
      moduleId: 'learning',
      platform: 'desktop',
      active: null,
      pending: { descriptor: { ...older, version: '1.0.0' } },
    })
    await expect(
      second.value.installConfirmedCandidate(candidate),
    ).resolves.toMatchObject({
      state: { pending: { descriptor: { version: '2.0.0' } } },
    })
  })
})
