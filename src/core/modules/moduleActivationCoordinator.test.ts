// eslint-disable-next-line import/no-nodejs-modules -- artifact hashing fixture runs only in Jest/Node
import { createHash, webcrypto } from 'node:crypto'

import { ModuleActivationCoordinator } from './moduleActivationCoordinator'
import type { VerifiedModuleArtifact } from './moduleArtifactVerifier'
import type { ModuleDeviceState } from './moduleDeviceStateStore'

const HASH = 'a'.repeat(64)
const RELEASE_ROOT =
  'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning-v1.0.0'

function pendingState(): ModuleDeviceState {
  return {
    moduleId: 'learning',
    platform: 'desktop',
    active: null,
    pending: {
      descriptor: {
        id: 'learning',
        version: '1.0.0',
        hostApi: '^1.0.0',
        platform: 'desktop',
        dataSchemas: {},
        manifestUrl:
          'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning-v1.0.0/module.json',
        manifest: { byteSize: 1, sha256: HASH },
      },
    },
  }
}

function coordinator(states: ModuleDeviceState[], enabled: boolean) {
  const durable = new Map(states.map((state) => [state.moduleId, state]))
  return {
    durable,
    value: new ModuleActivationCoordinator({
      deviceStateStore: {
        list: async () => [...durable.values()],
        runExclusive: async (moduleId, operation) =>
          operation({
            read: async () => durable.get(moduleId) ?? null,
            write: async (next) => {
              durable.set(moduleId, next)
              return next
            },
            remove: async () => {
              durable.delete(moduleId)
            },
          }),
      },
      intentStateSource: {
        load: async (ids) =>
          ids.map((id) => ({
            id,
            state: enabled ? ('enabled' as const) : ('disabled' as const),
          })),
      },
      artifactStore: {} as never,
      platform: 'desktop',
      hostApi: '1.0.0',
      loader: {
        load: async () => {
          throw new Error('not used')
        },
      },
      runtime: { activate: async () => undefined },
    }),
  }
}

describe('ModuleActivationCoordinator minimal state integration', () => {
  test('returns no results for an empty device state', async () => {
    const test = coordinator([], true)
    await expect(test.value.activatePersistedModules()).resolves.toEqual([])
  })

  test('leaves the target pending without executing code when intent is disabled', async () => {
    const test = coordinator([pendingState()], false)
    await expect(test.value.activatePersistedModules()).resolves.toEqual([
      expect.objectContaining({ moduleId: 'learning', status: 'skipped' }),
    ])
    expect(test.durable.get('learning')).toMatchObject({
      active: null,
      pending: expect.objectContaining({
        descriptor: expect.objectContaining({ version: '1.0.0' }),
      }),
    })
  })
})

/**
 * A complete, self-consistent installed artifact: manifest bytes hashed into
 * the descriptor, every declared file hashed into the manifest, and a version
 * tree whose closure matches. Enough for `verifyInstalledModuleArtifact` to
 * accept it, which is what publishes the artifact and runs the skill
 * projection hook.
 */
function verifiableActivation(
  materializeSkills?: (
    moduleId: string,
    artifact: VerifiedModuleArtifact,
    signal: AbortSignal,
  ) => Promise<void>,
  reportSkillProjectionError?: (moduleId: string, error: unknown) => void,
) {
  const encoder = new TextEncoder()
  const entryBytes = encoder.encode('/* entry */')
  const skillBytes = encoder.encode('---\nname: coach\n---\n')
  const sha = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex')
  const files = [
    {
      role: 'entry',
      name: 'entry.js',
      path: 'entry.js',
      byteSize: entryBytes.byteLength,
      sha256: sha(entryBytes),
      url: `${RELEASE_ROOT}/entry.js`,
      storage: 'module',
    },
    {
      role: 'data',
      name: 'skills-coach-SKILL.md',
      path: 'skills/coach/SKILL.md',
      byteSize: skillBytes.byteLength,
      sha256: sha(skillBytes),
      url: `${RELEASE_ROOT}/skills-coach-SKILL.md`,
      storage: 'module',
    },
  ]
  const manifestBytes = encoder.encode(
    JSON.stringify({
      schemaVersion: 1,
      id: 'learning',
      version: '1.0.0',
      hostApi: '^1.0.0',
      dataSchemas: {},
      variants: [{ platform: 'desktop', entry: 'entry.js', files }],
    }),
  )
  const bytesByPath = new Map<string, Uint8Array>([
    ['entry.js', entryBytes],
    ['skills/coach/SKILL.md', skillBytes],
  ])
  const state: ModuleDeviceState = {
    moduleId: 'learning',
    platform: 'desktop',
    active: null,
    pending: {
      descriptor: {
        id: 'learning',
        version: '1.0.0',
        hostApi: '^1.0.0',
        platform: 'desktop',
        dataSchemas: {},
        manifestUrl: `${RELEASE_ROOT}/module.json`,
        manifest: {
          byteSize: manifestBytes.byteLength,
          sha256: sha(manifestBytes),
        },
      },
    },
  }
  const durable = new Map([['learning', state]])
  return new ModuleActivationCoordinator({
    deviceStateStore: {
      list: async () => [...durable.values()],
      runExclusive: async (moduleId, operation) =>
        operation({
          read: async () => durable.get(moduleId) ?? null,
          write: async (next) => {
            durable.set(moduleId, next)
            return next
          },
          remove: async () => {
            durable.delete(moduleId)
          },
        }),
    },
    intentStateSource: {
      load: async (ids) => ids.map((id) => ({ id, state: 'enabled' as const })),
    },
    artifactStore: {
      readManifestBytes: async () => manifestBytes,
      readEntryBytes: async (_moduleId, _version, path) => {
        const bytes = bytesByPath.get(path)
        if (!bytes) throw new Error(`missing ${path}`)
        return bytes
      },
      listVersionFiles: async () => ['module.json', ...bytesByPath.keys()],
    },
    platform: 'desktop',
    hostApi: '1.0.0',
    loader: { load: async () => ({ activate: () => undefined }) as never },
    runtime: { activate: async () => undefined },
    subtleCrypto: webcrypto.subtle as unknown as SubtleCrypto,
    ...(materializeSkills ? { materializeSkills } : {}),
    ...(reportSkillProjectionError ? { reportSkillProjectionError } : {}),
  })
}

describe('ModuleActivationCoordinator skill projection', () => {
  test('projects the verified artifact once activation has committed', async () => {
    const materializeSkills = jest.fn(async () => undefined)
    const coordinator = verifiableActivation(materializeSkills)

    await expect(coordinator.activateModule('learning')).resolves.toMatchObject(
      { status: 'activated', version: '1.0.0' },
    )
    expect(materializeSkills).toHaveBeenCalledTimes(1)
    const [moduleId, artifact] = materializeSkills.mock.calls[0] as unknown as [
      string,
      VerifiedModuleArtifact,
    ]
    expect(moduleId).toBe('learning')
    expect(artifact.manifest.version).toBe('1.0.0')
    expect(artifact.variant.files.map((file) => file.path)).toContain(
      'skills/coach/SKILL.md',
    )
  })

  test('keeps the activation and reports when the projection cannot be written', async () => {
    const reportSkillProjectionError = jest.fn()
    const coordinator = verifiableActivation(async () => {
      throw new Error('vault is read-only')
    }, reportSkillProjectionError)

    // The module is live by this point: reporting it failed would advertise a
    // running module as broken and stop the reconciler from ever retrying it.
    await expect(coordinator.activateModule('learning')).resolves.toMatchObject(
      { status: 'activated', version: '1.0.0' },
    )
    expect(coordinator.getError('learning')).toBeUndefined()
    expect(reportSkillProjectionError).toHaveBeenCalledTimes(1)
    expect(reportSkillProjectionError.mock.calls[0][0]).toBe('learning')
    expect((reportSkillProjectionError.mock.calls[0][1] as Error).message).toBe(
      'vault is read-only',
    )
  })

  test('reports nothing when the projection is cut short by an abort', async () => {
    const reportSkillProjectionError = jest.fn()
    const coordinator = verifiableActivation(async (_id, _artifact, signal) => {
      // Stands in for the activation timeout or a plugin unload firing
      // mid-projection. The module is already active, and an abort is not a
      // defect anyone could act on.
      coordinator.dispose()
      expect(signal.aborted).toBe(true)
      throw new Error('Module skill projection was aborted')
    }, reportSkillProjectionError)

    await expect(coordinator.activateModule('learning')).resolves.toMatchObject(
      { status: 'activated' },
    )
    expect(reportSkillProjectionError).not.toHaveBeenCalled()
  })

  test('stops waiting on a projection that never settles', async () => {
    const reportSkillProjectionError = jest.fn()
    const coordinator = verifiableActivation(
      // A Vault adapter call that never returns. The signal cannot cancel an
      // already-pending Promise, so a bare await here would keep the whole
      // startup hanging behind one unresponsive read or write.
      (_id, _artifact, signal) =>
        new Promise<void>(() => {
          coordinator.dispose()
          expect(signal.aborted).toBe(true)
        }),
      reportSkillProjectionError,
    )

    await expect(coordinator.activateModule('learning')).resolves.toMatchObject(
      { status: 'activated' },
    )
    expect(reportSkillProjectionError).not.toHaveBeenCalled()
  })

  test('survives a throwing diagnostic sink', async () => {
    const coordinator = verifiableActivation(
      async () => {
        throw new Error('vault is read-only')
      },
      () => {
        throw new Error('logger exploded')
      },
    )

    await expect(coordinator.activateModule('learning')).resolves.toMatchObject(
      { status: 'activated' },
    )
  })
})
