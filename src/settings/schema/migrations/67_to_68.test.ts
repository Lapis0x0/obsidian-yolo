import { migrateFrom67To68 } from './67_to_68'

describe('migrateFrom67To68', () => {
  it('copies global focus sync and time awareness to every assistant', () => {
    const result = migrateFrom67To68({
      version: 67,
      timeContextEnabled: false,
      chatOptions: { includeCurrentFileContent: false },
      assistants: [
        { id: 'a1', name: 'Writer' },
        { id: 'a2', name: 'Coder', includeCurrentFileContent: true },
      ],
    })

    expect(result.version).toBe(68)
    expect(result.assistants).toEqual([
      {
        id: 'a1',
        name: 'Writer',
        includeCurrentFileContent: false,
        timeContextEnabled: false,
      },
      {
        id: 'a2',
        name: 'Coder',
        includeCurrentFileContent: true,
        timeContextEnabled: false,
      },
    ])
  })

  it('defaults missing globals to enabled when migrating assistants', () => {
    const result = migrateFrom67To68({
      version: 67,
      assistants: [{ id: 'a1', name: 'Default' }],
    })

    expect(result.assistants).toEqual([
      {
        id: 'a1',
        name: 'Default',
        includeCurrentFileContent: true,
        timeContextEnabled: true,
      },
    ])
  })
})
