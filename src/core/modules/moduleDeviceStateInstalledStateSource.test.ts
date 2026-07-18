import { ModuleDeviceStateInstalledStateSource } from './moduleDeviceStateInstalledStateSource'
import type { ModuleDeviceState } from './moduleDeviceStateStore'

function state(
  moduleId: string,
  pointers: Partial<
    Pick<
      ModuleDeviceState,
      'activeVersion' | 'pendingVersion' | 'downloadedCandidate' | 'transition'
    >
  >,
): ModuleDeviceState {
  return {
    moduleId,
    platform: 'desktop',
    activeVersion: null,
    pendingVersion: null,
    downloadedCandidate: null,
    readyVersions: {},
    transition: null,
    ...pointers,
  }
}

function source(
  states: readonly ModuleDeviceState[],
  activeIds: ReadonlySet<string> = new Set(),
  errors: Readonly<Record<string, string>> = {},
) {
  const list = jest.fn(async () => states)
  const isActive = jest.fn((moduleId: string) => activeIds.has(moduleId))
  return {
    source: new ModuleDeviceStateInstalledStateSource({
      store: { list },
      isActive,
      getError: (moduleId) => errors[moduleId],
    }),
    isActive,
    list,
  }
}

describe('ModuleDeviceStateInstalledStateSource', () => {
  it('preserves active, pending, candidate, and transition projections', async () => {
    const transition = Object.freeze({
      phase: 'prepared' as const,
      moduleId: 'pending',
      platform: 'desktop' as const,
      previousActiveVersion: null,
      targetVersion: '2.0.0',
      targetManifestSha256: 'a'.repeat(64),
      settings: null,
    })
    const fixture = source(
      [
        state('active', {
          activeVersion: '1.0.0',
          downloadedCandidate: '3.0.0',
        }),
        state('pending', {
          pendingVersion: '2.0.0',
          transition,
        }),
        state('candidate', { downloadedCandidate: '3.0.0' }),
        state('pointerless', {}),
      ],
      new Set(['active']),
    )

    const installed = await fixture.source.load()

    expect(installed).toEqual([
      {
        id: 'active',
        version: '1.0.0',
        candidateVersion: '3.0.0',
        active: true,
      },
      {
        id: 'pending',
        version: '2.0.0',
        pendingVersion: '2.0.0',
        transitionPhase: 'prepared',
      },
      { id: 'candidate', version: '3.0.0', candidateVersion: '3.0.0' },
    ])
    expect(Object.isFrozen(installed)).toBe(true)
    expect(installed.every(Object.isFrozen)).toBe(true)
  })

  it('does not report a persisted active pointer as running before activation', async () => {
    const fixture = source([state('learning', { activeVersion: '1.0.0' })])

    await expect(fixture.source.load()).resolves.toEqual([
      { id: 'learning', version: '1.0.0' },
    ])
    expect(fixture.isActive).toHaveBeenCalledWith('learning', '1.0.0')
  })

  it('projects isolated startup activation errors', async () => {
    const fixture = source(
      [state('learning', { activeVersion: '1.0.0' })],
      new Set(),
      { learning: 'entry verification failed' },
    )

    await expect(fixture.source.load()).resolves.toEqual([
      {
        id: 'learning',
        version: '1.0.0',
        error: 'entry verification failed',
      },
    ])
  })

  it('preserves every enumerated installed record without a catalog lookup', async () => {
    const fixture = source(
      [state('catalog-withdrawn', { activeVersion: '4.0.0' })],
      new Set(['catalog-withdrawn']),
    )

    await expect(fixture.source.load()).resolves.toEqual([
      { id: 'catalog-withdrawn', version: '4.0.0', active: true },
    ])
    expect(fixture.list).toHaveBeenCalledTimes(1)
  })

  it('returns a frozen empty array for empty and pointerless state', async () => {
    const empty = await source([]).source.load()
    const pointerless = await source([state('pointerless', {})]).source.load()

    expect(empty).toBe(pointerless)
    expect(empty).toEqual([])
    expect(Object.isFrozen(empty)).toBe(true)
  })

  it('propagates state-store enumeration failures', async () => {
    const failure = new Error('corrupt device state')
    const store = {
      list: jest.fn(async () => {
        throw failure
      }),
    }

    await expect(
      new ModuleDeviceStateInstalledStateSource({
        store,
        isActive: () => false,
      }).load(),
    ).rejects.toBe(failure)
  })
})
