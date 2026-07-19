// eslint-disable-next-line import/no-nodejs-modules -- journal integrity tests require Node's real Web Crypto implementation
import { webcrypto } from 'node:crypto'

import {
  type ModuleTransitionJournal,
  type ModuleTransitionJournalBinding,
  type ModuleTransitionSettingsSnapshot,
  type SnapshotVerifiedModuleTransitionJournal,
  hashModuleTransitionSettingsSnapshot,
  parseModuleTransitionJournal,
  verifyModuleTransitionJournalSnapshot,
} from './moduleTransitionJournal'

const subtleCrypto = webcrypto.subtle as unknown as Pick<SubtleCrypto, 'digest'>
const HASH = 'a'.repeat(64)

function journal(
  previous: ModuleTransitionSettingsSnapshot,
  previousSha256 = '0'.repeat(64),
): ModuleTransitionJournal {
  return parseModuleTransitionJournal(
    journalValue(previous, previousSha256),
    binding({}, previous.present ? previous.envelope.schemaVersion : 0),
  )
}

function journalValue(
  previous: ModuleTransitionSettingsSnapshot,
  previousSha256 = '0'.repeat(64),
): unknown {
  const sourceSchemaVersion = previous.present
    ? previous.envelope.schemaVersion
    : 0
  return {
    phase: 'prepared',
    moduleId: 'learning',
    platform: 'desktop',
    previousActiveVersion: '1.0.0',
    targetVersion: '2.0.0',
    targetManifestSha256: HASH,
    settings: {
      namespace: 'settings',
      location: {
        moduleId: 'learning',
        storageRoot: 'YOLO/.yolo_json_db/module-settings',
        storagePath: 'YOLO/.yolo_json_db/module-settings/learning.json',
      },
      sourceSchemaVersion,
      targetSchemaVersion: sourceSchemaVersion,
      previous,
      previousSha256,
      expectedPostSha256: 'f'.repeat(64),
    },
  }
}

function binding(
  patch: Partial<ModuleTransitionJournalBinding> = {},
  settingsWrite = 1,
): ModuleTransitionJournalBinding {
  return {
    moduleId: 'learning',
    platform: 'desktop',
    activeVersion: '1.0.0',
    downloadedCandidate: null,
    pendingVersion: '2.0.0',
    readyVersions: ['1.0.0', '2.0.0'],
    targetDescriptor: {
      manifest: { sha256: HASH },
      dataSchemas: {
        settings: { readMin: 0, readMax: 2, write: settingsWrite },
      },
    },
    ...patch,
  }
}

describe('module transition journal snapshot digest verification', () => {
  it('allows forward-only settings migration metadata to remain outside the journal', async () => {
    const statelessBinding = binding({
      targetDescriptor: { manifest: { sha256: HASH }, dataSchemas: {} },
    })
    const stateless = {
      ...(journalValue(
        { present: false, envelope: null },
        '0'.repeat(64),
      ) as Record<string, unknown>),
      settings: null,
    }
    const digest = jest.fn<
      ReturnType<SubtleCrypto['digest']>,
      Parameters<SubtleCrypto['digest']>
    >()

    await expect(
      verifyModuleTransitionJournalSnapshot(stateless, statelessBinding, {
        digest,
      }),
    ).resolves.toMatchObject({ settings: null })
    expect(digest).not.toHaveBeenCalled()
    expect(() =>
      parseModuleTransitionJournal(stateless, binding()),
    ).not.toThrow()
    expect(() =>
      parseModuleTransitionJournal(
        journalValue({ present: false, envelope: null }),
        statelessBinding,
      ),
    ).toThrow('must be null')
  })

  it.each([
    { moduleId: 'other' },
    { storageRoot: '../outside' },
    { storageRoot: 'Safe//Root' },
    { storageRoot: 'Safe\\Root' },
    { storageRoot: 'Safe/Arbitrary/Root' },
    { storageRoot: 'Safe/.yolo_json_db/module-setting' },
    { storageRoot: 'Safe/not.yolo_json_db/module-settings' },
    { storagePath: 'Outside/learning.json' },
  ])('rejects invalid or unbound settings location %#', (patch) => {
    const value = journalValue({ present: false, envelope: null }) as {
      settings: { location: Record<string, string> }
    }
    value.settings.location = {
      ...value.settings.location,
      ...(patch as unknown as Record<string, string>),
    }

    expect(() => parseModuleTransitionJournal(value, binding())).toThrow()
  })

  it('rejects schema-changing settings at durable journal admission', () => {
    const value = journalValue({
      present: true,
      envelope: { schemaVersion: 1, data: {} },
    }) as { settings: { targetSchemaVersion: number } }
    value.settings.targetSchemaVersion = 2

    expect(() => parseModuleTransitionJournal(value, binding({}, 2))).toThrow(
      'schemas do not match',
    )
  })

  it('verifies canonical previous snapshot bytes and returns the branded frozen journal', async () => {
    const parsed = journal({
      present: true,
      envelope: { schemaVersion: 1, data: { deck: 'A', flags: [true] } },
    })
    const digest = await hashModuleTransitionSettingsSnapshot(
      parsed.settings!.previous,
      subtleCrypto,
    )
    const digestBound = journalValue(parsed.settings!.previous, digest)

    const verified: SnapshotVerifiedModuleTransitionJournal =
      await verifyModuleTransitionJournalSnapshot(
        digestBound,
        binding(),
        subtleCrypto,
      )

    expect(verified).toEqual(digestBound)
    expect(Object.isFrozen(verified)).toBe(true)
    expect(Object.isFrozen(verified.settings!.previous.envelope?.data)).toBe(
      true,
    )
  })

  it('rejects a structurally valid journal whose previous snapshot hash mismatches', async () => {
    const parsed = journal({
      present: true,
      envelope: { schemaVersion: 1, data: { deck: 'A' } },
    })

    await expect(
      verifyModuleTransitionJournalSnapshot(parsed, binding(), subtleCrypto),
    ).rejects.toThrow('SHA-256 mismatch')
  })

  it('cannot brand input with invalid bindings or schemas even when its hash is valid', async () => {
    const parsed = journal({
      present: true,
      envelope: { schemaVersion: 1, data: { deck: 'A' } },
    })
    const digest = await hashModuleTransitionSettingsSnapshot(
      parsed.settings!.previous,
      subtleCrypto,
    )
    const valid = journalValue(parsed.settings!.previous, digest)

    await expect(
      verifyModuleTransitionJournalSnapshot(
        valid,
        binding({ moduleId: 'other' }),
        subtleCrypto,
      ),
    ).rejects.toThrow('moduleId does not match')
    await expect(
      verifyModuleTransitionJournalSnapshot(
        {
          ...(valid as Record<string, unknown>),
          settings: {
            ...(valid as { settings: Record<string, unknown> }).settings,
            sourceSchemaVersion: -1,
          },
        },
        binding(),
        subtleCrypto,
      ),
    ).rejects.toThrow('source settings schema')
  })

  it('hashes canonically equivalent object key orders identically', async () => {
    const left = journal({
      present: true,
      envelope: {
        schemaVersion: 1,
        data: { z: 1, a: { right: true, left: false } },
      },
    })
    const right = journal({
      present: true,
      envelope: {
        data: { a: { left: false, right: true }, z: 1 },
        schemaVersion: 1,
      },
    })

    await expect(
      hashModuleTransitionSettingsSnapshot(
        left.settings!.previous,
        subtleCrypto,
      ),
    ).resolves.toBe(
      await hashModuleTransitionSettingsSnapshot(
        right.settings!.previous,
        subtleCrypto,
      ),
    )
  })

  it('hashes absent settings distinctly from a present null envelope', async () => {
    const absent = journal({ present: false, envelope: null })
    const present = journal({
      present: true,
      envelope: { schemaVersion: 0, data: null },
    })

    const absentHash = await hashModuleTransitionSettingsSnapshot(
      absent.settings!.previous,
      subtleCrypto,
    )
    const presentHash = await hashModuleTransitionSettingsSnapshot(
      present.settings!.previous,
      subtleCrypto,
    )

    expect(absentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(presentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(absentHash).not.toBe(presentHash)
  })
})
