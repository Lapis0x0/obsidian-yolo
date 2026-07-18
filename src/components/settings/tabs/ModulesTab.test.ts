jest.mock('../../../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('../../modals/ConfirmModal', () => ({ ConfirmModal: jest.fn() }))

import type {
  ConfirmedModuleCandidate,
  ModuleRecord,
} from '../../../core/modules'

import {
  type ModuleProductCapabilities,
  executeModuleProductAction,
  getModuleProductActions,
  hasModuleProductCapabilities,
  requiresModuleProductConfirmation,
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

function capabilities(): jest.Mocked<ModuleProductCapabilities> {
  return {
    getModuleInstallCandidate: jest.fn(),
    hasModuleProductCapabilities: jest.fn(() => true),
    installConfirmedModuleCandidate: jest.fn().mockResolvedValue(undefined),
    setModuleDesiredInstalled: jest.fn().mockResolvedValue(undefined),
    setModuleEnabled: jest.fn().mockResolvedValue(undefined),
    uninstallInactiveModule: jest.fn().mockResolvedValue(undefined),
    uninstallAndRemoveModuleData: jest.fn().mockResolvedValue(undefined),
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

  it.each(['development', 'bundled'])(
    'hides product actions in %s mode even when product methods exist',
    () => {
      const host = capabilities()
      host.hasModuleProductCapabilities = jest.fn(() => false)

      expect(hasModuleProductCapabilities(host)).toBe(false)
      expect(
        getModuleProductActions(moduleRecord({ id: 'notes' }), false),
      ).toEqual([])
    },
  )

  it('does not infer product availability from methods alone', () => {
    const host = capabilities()
    delete host.hasModuleProductCapabilities

    expect(hasModuleProductCapabilities(host)).toBe(false)
    expect(getModuleProductActions(moduleRecord({ id: 'notes' }))).toEqual([])
  })

  it('shows the unchanged product actions in production mode', () => {
    const host = capabilities()

    expect(hasModuleProductCapabilities(host)).toBe(true)
    expect(
      getModuleProductActions(moduleRecord({ id: 'notes' }), true),
    ).toEqual(['install'])
  })

  it('requires confirmation only for install and uninstall', () => {
    expect(requiresModuleProductConfirmation('install')).toBe(true)
    expect(requiresModuleProductConfirmation('uninstall')).toBe(true)
    expect(requiresModuleProductConfirmation('enable')).toBe(false)
    expect(requiresModuleProductConfirmation('disable')).toBe(false)
  })

  it('establishes install intent before submitting the confirmed candidate', async () => {
    const host = capabilities()
    const confirmedCandidate = candidate()
    await executeModuleProductAction(
      host,
      moduleRecord({ id: 'notes' }),
      'install',
      confirmedCandidate,
    )

    expect(host.setModuleDesiredInstalled).toHaveBeenCalledWith('notes', true)
    expect(host.installConfirmedModuleCandidate).toHaveBeenCalledWith(
      confirmedCandidate,
    )
    expect(
      host.setModuleDesiredInstalled.mock.invocationCallOrder[0],
    ).toBeLessThan(
      host.installConfirmedModuleCandidate.mock.invocationCallOrder[0],
    )
  })

  it('submits the candidate fixed at confirmation when the catalog changes', async () => {
    const host = capabilities()
    const confirmedCandidate = candidate('1.0.0', 'a'.repeat(64))
    host.getModuleInstallCandidate
      .mockReturnValueOnce(confirmedCandidate)
      .mockReturnValue(candidate('2.0.0', 'b'.repeat(64)))

    const candidateAtConfirmation = host.getModuleInstallCandidate('notes')
    expect(candidateAtConfirmation).toBe(confirmedCandidate)

    await executeModuleProductAction(
      host,
      moduleRecord({ id: 'notes' }),
      'install',
      candidateAtConfirmation,
    )

    expect(host.getModuleInstallCandidate).toHaveBeenCalledTimes(1)
    expect(host.installConfirmedModuleCandidate).toHaveBeenCalledWith(
      confirmedCandidate,
    )
    expect(host.installConfirmedModuleCandidate).not.toHaveBeenCalledWith(
      candidate('2.0.0', 'b'.repeat(64)),
    )
  })

  it('changes only enable intent and requires reload', async () => {
    const host = capabilities()
    const module = moduleRecord({
      id: 'notes',
      installed: { active: true, id: 'notes', version: '1.0.0' },
      status: 'active',
    })

    await expect(
      executeModuleProductAction(host, module, 'disable'),
    ).resolves.toEqual({ reloadRequired: true })
    expect(host.setModuleEnabled).toHaveBeenCalledWith('notes', false)
    expect(host.setModuleDesiredInstalled).not.toHaveBeenCalled()
    expect(host.uninstallInactiveModule).not.toHaveBeenCalled()
  })

  it('clears uninstall intent but keeps an active module for reload', async () => {
    const host = capabilities()
    const active = moduleRecord({
      id: 'notes',
      installed: { active: true, id: 'notes', version: '1.0.0' },
      status: 'active',
    })

    await expect(
      executeModuleProductAction(host, active, 'uninstall'),
    ).resolves.toEqual({ reloadRequired: true })
    expect(host.setModuleDesiredInstalled).toHaveBeenCalledWith('notes', false)
    expect(host.uninstallInactiveModule).not.toHaveBeenCalled()
  })

  it('clears intent before safely uninstalling an inactive module', async () => {
    const host = capabilities()
    const inactive = moduleRecord({
      id: 'notes',
      installed: { active: false, id: 'notes', version: '1.0.0' },
      status: 'disabled',
    })

    await executeModuleProductAction(host, inactive, 'uninstall')
    expect(
      host.setModuleDesiredInstalled.mock.invocationCallOrder[0],
    ).toBeLessThan(host.uninstallInactiveModule.mock.invocationCallOrder[0])
  })

  it('surfaces a failed candidate installation and allows a real retry', async () => {
    const host = capabilities()
    host.installConfirmedModuleCandidate
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(undefined)
    const available = moduleRecord({ id: 'notes' })
    const confirmedCandidate = candidate()

    await expect(
      executeModuleProductAction(
        host,
        available,
        'install',
        confirmedCandidate,
      ),
    ).rejects.toThrow('network unavailable')
    await expect(
      executeModuleProductAction(
        host,
        available,
        'install',
        confirmedCandidate,
      ),
    ).resolves.toEqual({ reloadRequired: false })
    expect(host.installConfirmedModuleCandidate).toHaveBeenCalledTimes(2)
    expect(host.setModuleDesiredInstalled).toHaveBeenCalledTimes(2)
  })

  it('fails explicitly when a required host capability is absent', async () => {
    await expect(
      executeModuleProductAction(
        { hasModuleProductCapabilities: () => true },
        moduleRecord({ id: 'notes' }),
        'install',
        candidate(),
      ),
    ).rejects.toThrow(
      'Module host capability is unavailable: setModuleDesiredInstalled',
    )
  })

  it('rejects product actions when the host marks them unavailable', async () => {
    const host = capabilities()
    host.hasModuleProductCapabilities = jest.fn(() => false)

    await expect(
      executeModuleProductAction(
        host,
        moduleRecord({ id: 'notes' }),
        'install',
      ),
    ).rejects.toThrow('Module product capabilities are unavailable')
    expect(host.setModuleDesiredInstalled).not.toHaveBeenCalled()
  })
})
