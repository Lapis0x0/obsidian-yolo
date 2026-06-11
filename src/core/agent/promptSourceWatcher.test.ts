import type { TAbstractFile } from 'obsidian'

import { PromptSourceWatcher } from './promptSourceWatcher'

const file = (path: string): TAbstractFile => ({ path }) as TAbstractFile

describe('PromptSourceWatcher', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('tracks watched external changes', () => {
    const watcher = new PromptSourceWatcher()
    const listener = jest.fn()
    watcher.onExternalChange(listener)
    watcher.setWatchedPaths(new Set(['YOLO/memory/global.md']))
    const handlers = watcher.buildVaultHandlers()

    handlers.modify(file('YOLO/memory/global.md'))

    expect(watcher.getRevision()).toBe(1)

    jest.advanceTimersByTime(100)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores unwatched paths and internal writes', async () => {
    const watcher = new PromptSourceWatcher()
    watcher.setWatchedPaths(new Set(['YOLO/memory/global.md']))
    const handlers = watcher.buildVaultHandlers()

    handlers.modify(file('notes/regular.md'))
    expect(watcher.getRevision()).toBe(0)

    await watcher.withInternalWrite('YOLO/memory/global.md', async () => {
      handlers.modify(file('YOLO/memory/global.md'))
    })

    expect(watcher.getRevision()).toBe(0)
  })
})
