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
  executeModuleProductAction,
  getModuleProductActions,
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
  it.each([
    ['available', moduleRecord({ id: 'notes' }), ['install']],
    [
      'enabled installation',
      moduleRecord({
        desiredInstalled: true,
        enabled: true,
        id: 'notes',
        installed: { id: 'notes', version: '1.0.0' },
      }),
      ['disable', 'uninstall'],
    ],
    [
      'disabled installation',
      moduleRecord({
        desiredInstalled: true,
        enabled: false,
        id: 'notes',
        installed: { id: 'notes', version: '1.0.0' },
      }),
      ['enable', 'uninstall'],
    ],
    [
      'disabled synchronized intent without local artifacts',
      moduleRecord({
        desiredInstalled: true,
        enabled: false,
        id: 'notes',
        status: 'disabled',
      }),
      ['enable', 'uninstall'],
    ],
    [
      'uninstall pending',
      moduleRecord({
        desiredInstalled: false,
        enabled: false,
        id: 'notes',
        installed: { id: 'notes', version: '1.0.0' },
      }),
      ['uninstall'],
    ],
  ])('derives the %s action matrix', (_label, module, expected) => {
    expect(getModuleProductActions(module, true)).toEqual(expected)
  })

  it('hides product actions when official management is unavailable', () => {
    expect(
      getModuleProductActions(moduleRecord({ id: 'notes' }), false),
    ).toEqual([])
  })

  it('hides install and enable for incompatible modules', () => {
    const unavailable = moduleRecord({
      compatibilityIssues: [{ kind: 'host-api' }],
      id: 'notes',
    })
    const disabled = moduleRecord({
      compatibilityIssues: [{ kind: 'data-schema' }],
      desiredInstalled: true,
      enabled: false,
      id: 'notes',
      installed: { id: 'notes', version: '1.0.0' },
    })

    expect(getModuleProductActions(unavailable, true)).toEqual([])
    expect(getModuleProductActions(disabled, true)).toEqual(['uninstall'])
  })

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
