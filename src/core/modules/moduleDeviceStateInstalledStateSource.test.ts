import { ModuleDeviceStateInstalledStateSource } from './moduleDeviceStateInstalledStateSource'
import type { ModuleDeviceState } from './moduleDeviceStateStore'

function state(
  moduleId: string,
  pointers: Partial<
    Pick<
      ModuleDeviceState,
      'activeVersion' | 'pendingVersion' | 'downloadedCandidate'
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
    ...pointers,
  }
}

function source(
  states: readonly ModuleDeviceState[],
  activeIds: ReadonlySet<string> = new Set(),
) {
  const list = jest.fn(async () => states)
  const isActive = jest.fn((moduleId: string) => activeIds.has(moduleId))
  return {
    source: new ModuleDeviceStateInstalledStateSource({
      store: { list },
      isActive,
    }),
    isActive,
    list,
  }
}

describe('ModuleDeviceStateInstalledStateSource', () => {
  it('maps active first, then pending, then downloaded candidate', async () => {
    const fixture = source(
      [
        state('active', {
          activeVersion: '1.0.0',
          pendingVersion: '2.0.0',
          downloadedCandidate: '3.0.0',
        }),
        state('pending', {
          pendingVersion: '2.0.0',
          downloadedCandidate: '3.0.0',
        }),
        state('candidate', { downloadedCandidate: '3.0.0' }),
        state('pointerless', {}),
      ],
      new Set(['active']),
    )

    const installed = await fixture.source.load()

    expect(installed).toEqual([
      { id: 'active', version: '1.0.0', active: true },
      { id: 'pending', version: '2.0.0' },
      { id: 'candidate', version: '3.0.0' },
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
