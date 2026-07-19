import {
  type ModuleStartupReloadGuardStorage,
  clearModuleStartupReloadAttempt,
  consumeModuleStartupReloadAttempt,
} from './moduleStartupReloadGuard'

function storage(): ModuleStartupReloadGuardStorage & {
  readonly values: Map<string, string>
} {
  const values = new Map<string, string>()
  return {
    values,
    getItem: jest.fn((key: string) => values.get(key) ?? null),
    removeItem: jest.fn((key: string) => {
      values.delete(key)
    }),
    setItem: jest.fn((key: string, value: string) => {
      values.set(key, value)
    }),
  }
}

describe('module startup reload guard', () => {
  it('allows only one automatic reload until startup succeeds', () => {
    const session = storage()

    expect(consumeModuleStartupReloadAttempt(session)).toBe(true)
    expect(consumeModuleStartupReloadAttempt(session)).toBe(false)

    clearModuleStartupReloadAttempt(session)

    expect(consumeModuleStartupReloadAttempt(session)).toBe(true)
  })

  it('suppresses automatic reload when storage is unavailable', () => {
    const session = storage()
    session.setItem = jest.fn(() => {
      throw new Error('storage unavailable')
    })

    expect(consumeModuleStartupReloadAttempt(session)).toBe(false)
    expect(session.values.size).toBe(0)
  })
})
