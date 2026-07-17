import { ModuleContributionStager } from './contributionStager'

const view = {
  type: 'test-view',
  name: 'Test view',
  icon: 'flask-conical',
  render: () => null,
}

describe('ModuleContributionStager', () => {
  it('returns one validated view and ribbon only after staging finishes', () => {
    const stager = new ModuleContributionStager()
    const action = {
      icon: 'flask-conical',
      title: 'Test action',
      onClick: jest.fn(),
    }
    stager.workspace.registerView(view)
    stager.workspace.registerRibbonAction(action)

    expect(stager.finish()).toEqual({ view, ribbonAction: action })
    expect(() => stager.workspace.registerView(view)).toThrow('synchronously')
  })

  it('rejects invalid, duplicate, and empty declarations before commit', () => {
    const duplicate = new ModuleContributionStager()
    duplicate.workspace.registerView(view)
    expect(() => duplicate.workspace.registerView(view)).toThrow(
      'only one view',
    )

    const invalid = new ModuleContributionStager()
    expect(() =>
      invalid.workspace.registerRibbonAction({
        icon: '',
        title: 'Action',
        onClick: () => undefined,
      }),
    ).toThrow('non-empty string')
    expect(() => new ModuleContributionStager().finish()).toThrow(
      'no workspace contributions',
    )
  })

  it('allows capability-only activation when explicitly requested', () => {
    const stager = new ModuleContributionStager()
    expect(stager.finish({ allowEmpty: true })).toEqual({})
  })

  it('stages multiple uniquely named module commands', () => {
    const stager = new ModuleContributionStager()
    const first = { id: 'open', name: 'Open module', callback: jest.fn() }
    const second = {
      id: 'refresh',
      name: 'Refresh module',
      callback: jest.fn(),
    }

    stager.workspace.registerCommand(first)
    stager.workspace.registerCommand(second)

    expect(stager.finish()).toEqual({ commands: [first, second] })
  })

  it('rejects duplicate and unsafe command ids', () => {
    const stager = new ModuleContributionStager()
    stager.workspace.registerCommand({
      id: 'open',
      name: 'Open module',
      callback: jest.fn(),
    })
    expect(() =>
      stager.workspace.registerCommand({
        id: 'open',
        name: 'Duplicate',
        callback: jest.fn(),
      }),
    ).toThrow('already registered')
    expect(() =>
      new ModuleContributionStager().workspace.registerCommand({
        id: '../open',
        name: 'Unsafe',
        callback: jest.fn(),
      }),
    ).toThrow('id is invalid')
  })
})
