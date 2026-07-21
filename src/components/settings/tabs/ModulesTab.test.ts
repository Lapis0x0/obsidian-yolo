jest.mock('../../../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('../../modals/ConfirmModal', () => ({ ConfirmModal: jest.fn() }))

import type {
  ConfirmedModuleCandidate,
  ModuleRecord,
} from '../../../core/modules'
import type { ModuleService } from '../../../core/modules/moduleService'

import {
  createFailedOperation,
  executeModuleProductAction,
  getModuleManagementView,
  getModuleShelfActions,
  getRetryAction,
  hasModuleUpdate,
  partitionModules,
  projectModuleSettingsNavigation,
} from './ModulesTab'

function moduleRecord(
  value: Partial<ModuleRecord> & Pick<ModuleRecord, 'id'>,
): ModuleRecord {
  return {
    description: '',
    name: value.id,
    status: 'available',
    version: '1.0.0',
    ...value,
  }
}

function candidate(
  expectedVersion = '1.0.0',
  expectedManifestSha256 = 'a'.repeat(64),
): ConfirmedModuleCandidate {
  return {
    expectedManifestSha256,
    expectedVersion,
    moduleId: 'notes',
  }
}

function service(): jest.Mocked<
  Pick<ModuleService, 'install' | 'setEnabled' | 'uninstall'>
> {
  return {
    install: jest.fn().mockResolvedValue({}),
    setEnabled: jest.fn().mockResolvedValue({}),
    uninstall: jest.fn().mockResolvedValue({}),
  }
}

describe('ModulesTab product actions', () => {
  it('submits the exact candidate captured by the confirmation', async () => {
    const modules = service()
    const confirmed = candidate('1.0.0', 'a'.repeat(64))

    await expect(
      executeModuleProductAction(
        modules,
        moduleRecord({ id: 'notes' }),
        'install',
        confirmed,
      ),
    ).resolves.toEqual({})
    expect(modules.install).toHaveBeenCalledTimes(1)
    expect(modules.install).toHaveBeenCalledWith(confirmed)
  })

  it('rejects install without a matching confirmed candidate', async () => {
    const modules = service()

    await expect(
      executeModuleProductAction(
        modules,
        moduleRecord({ id: 'notes' }),
        'install',
        { ...candidate(), moduleId: 'other' },
      ),
    ).rejects.toThrow('No confirmed install candidate is available for notes')
    expect(modules.install).not.toHaveBeenCalled()
  })

  it.each([
    ['enable', true],
    ['disable', false],
  ] as const)('delegates %s to the service', async (action, enabled) => {
    const modules = service()

    await executeModuleProductAction(
      modules,
      moduleRecord({ id: 'notes' }),
      action,
    )

    expect(modules.setEnabled).toHaveBeenCalledWith('notes', enabled)
  })

  it('delegates the complete uninstall decision to the service', async () => {
    const modules = service()

    await executeModuleProductAction(
      modules,
      moduleRecord({ id: 'notes' }),
      'uninstall',
    )

    expect(modules.uninstall).toHaveBeenCalledWith('notes')
  })
})

describe('module shelf projections', () => {
  const installed = { id: 'notes', version: '1.0.0' }
  const catalog = { id: 'notes', version: '1.1.0' }

  it('partitions by product intent even for pending and failed records', () => {
    const enabled = moduleRecord({
      id: 'enabled',
      desiredInstalled: true,
      enabled: true,
      status: 'failed',
    })
    const disabled = moduleRecord({
      id: 'disabled',
      desiredInstalled: true,
      enabled: false,
      status: 'activation-pending',
    })
    const available = moduleRecord({
      id: 'available',
      desiredInstalled: false,
    })

    expect(partitionModules([available, disabled, enabled])).toEqual({
      enabled: [enabled],
      disabled: [disabled],
      available: [available],
    })
  })

  it('derives updates independently from the status overwritten by disabled intent', () => {
    const disabled = moduleRecord({
      id: 'notes',
      desiredInstalled: true,
      enabled: false,
      installed,
      catalog,
      status: 'disabled',
    })

    expect(hasModuleUpdate(disabled)).toBe(true)
    expect(getModuleShelfActions(disabled)).toEqual([
      'update-enable',
      'uninstall',
    ])
  })

  it('uses the confirmed action matrix and preserves uninstall for incompatible disabled modules', () => {
    expect(
      getModuleShelfActions(
        moduleRecord({
          id: 'notes',
          desiredInstalled: true,
          enabled: true,
          installed,
          catalog: { ...catalog, version: '1.0.0' },
        }),
        true,
      ),
    ).toEqual(['settings', 'disable'])
    expect(
      getModuleShelfActions(
        moduleRecord({
          id: 'notes',
          desiredInstalled: true,
          enabled: false,
          installed,
          catalog,
          compatibilityIssues: [{ kind: 'host-api' }],
        }),
      ),
    ).toEqual(['uninstall'])
  })

  it('aggregates multiple contributions into one enabled module navigation item', () => {
    const module = moduleRecord({
      id: 'notes',
      desiredInstalled: true,
      enabled: true,
    })
    const fields = {
      getSnapshot: jest.fn(),
      write: jest.fn(),
      subscribe: jest.fn(),
    }
    const registrations = ['general', 'advanced'].map((id) => ({
      moduleId: 'notes',
      contribution: {
        id,
        icon: 'notebook',
        title: id,
        fields: [],
      },
      fields,
    }))

    expect(projectModuleSettingsNavigation([module], registrations)).toEqual([
      {
        module,
        registrations,
        icon: 'notebook',
      },
    ])
    expect(
      projectModuleSettingsNavigation(
        [{ ...module, enabled: false }],
        registrations,
      ),
    ).toEqual([])
  })

  it('keeps update-and-enable as the retry action after install fails', () => {
    const failed = createFailedOperation('learning', 'update-enable', 'failed')
    expect(getRetryAction(failed, 'learning')).toBe('update-enable')
    expect(getRetryAction(failed, 'other')).toBeUndefined()
  })

  it('keeps stale modules visible beside a compact load error', () => {
    expect(
      getModuleManagementView({
        status: 'error',
        modules: [moduleRecord({ id: 'learning' })],
      }),
    ).toBe('content')
    expect(getModuleManagementView({ status: 'error', modules: [] })).toBe(
      'error',
    )
  })
})
