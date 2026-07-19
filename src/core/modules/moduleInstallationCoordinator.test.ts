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
      state: { pendingVersion: '2.0.0', activationPhase: 'pending' },
    })
    expect(test.durable()).toMatchObject({
      activeVersion: null,
      pendingVersion: '2.0.0',
      activationPhase: 'pending',
    })
  })

  test('rejects another installation while activation is pending', async () => {
    const first = harness()
    await first.value.installConfirmedCandidate(candidate)
    const second = harness(first.durable())
    await expect(
      second.value.installConfirmedCandidate(candidate),
    ).rejects.toThrow('blocked by a pending activation')
  })
})
