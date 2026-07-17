import { BackgroundActivityRegistry } from './backgroundActivityRegistry'

const activity = (id: string) => ({
  id,
  kind: 'test',
  title: id,
  status: 'running' as const,
  updatedAt: 0,
})

describe('BackgroundActivityRegistry', () => {
  it('publishes a batch as one complete snapshot', () => {
    const registry = new BackgroundActivityRegistry()
    const snapshots: string[][] = []
    registry.subscribe((activities) => {
      snapshots.push([...activities.keys()])
    })

    registry.upsertAll([activity('first'), activity('second')])

    expect(snapshots).toEqual([[], ['first', 'second']])
  })

  it('isolates subscriber failures', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    const registry = new BackgroundActivityRegistry()
    const subscriber = jest.fn()
    registry.subscribe(() => {
      throw new Error('subscriber failed')
    })
    registry.subscribe(subscriber)

    expect(() => registry.upsert(activity('work'))).not.toThrow()
    expect(subscriber).toHaveBeenLastCalledWith(
      new Map([['work', activity('work')]]),
    )
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
