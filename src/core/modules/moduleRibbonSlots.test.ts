import type { Plugin } from 'obsidian'

import { ModuleRibbonSlots } from './moduleRibbonSlots'

function createPlugin(stored: unknown = null) {
  let storage = stored
  const removeRibbonAction = jest.fn()
  const buttons: Array<{ title: string; detach: jest.Mock }> = []
  const addRibbonIcon = jest.fn((_icon: string, title: string) => {
    const button = { title, detach: jest.fn() }
    buttons.push(button)
    return button
  })
  const plugin = {
    manifest: { id: 'yolo' },
    app: {
      workspace: { leftRibbon: { removeRibbonAction } },
      loadLocalStorage: jest.fn(() => storage),
      saveLocalStorage: jest.fn((_key: string, value: unknown) => {
        storage = value
      }),
    },
    addRibbonIcon,
  } as unknown as Plugin
  return {
    plugin,
    addRibbonIcon,
    removeRibbonAction,
    buttons,
    storage: () => storage,
  }
}

describe('ModuleRibbonSlots', () => {
  it('restores remembered icons so activation takes over the same ribbon id', () => {
    const env = createPlugin({
      whiteboard: { icon: 'layout-dashboard', title: 'New board' },
    })
    const slots = new ModuleRibbonSlots(env.plugin)
    slots.restore()
    expect(env.addRibbonIcon).toHaveBeenCalledWith(
      'layout-dashboard',
      'New board',
      expect.any(Function),
    )

    const onClick = jest.fn()
    slots.bind('whiteboard', 'layout-dashboard', 'New board', onClick)
    slots.releaseUnclaimed()

    expect(env.addRibbonIcon).toHaveBeenLastCalledWith(
      'layout-dashboard',
      'New board',
      onClick,
    )
    expect(env.removeRibbonAction).not.toHaveBeenCalled()
    expect(env.storage()).toEqual({
      whiteboard: { icon: 'layout-dashboard', title: 'New board' },
    })
  })

  it('replaces a placeholder whose title no longer matches', () => {
    const env = createPlugin({
      whiteboard: { icon: 'layout-dashboard', title: '新建白板' },
    })
    const slots = new ModuleRibbonSlots(env.plugin)
    slots.restore()
    slots.bind('whiteboard', 'layout-dashboard', 'New board', jest.fn())

    expect(env.removeRibbonAction).toHaveBeenCalledWith('yolo:新建白板')
    expect(env.buttons[0]?.detach).toHaveBeenCalled()
    expect(env.storage()).toEqual({
      whiteboard: { icon: 'layout-dashboard', title: 'New board' },
    })
  })

  it('drops placeholders that no module claimed during startup', () => {
    const env = createPlugin({
      learning: { icon: 'graduation-cap', title: 'Learning' },
    })
    const slots = new ModuleRibbonSlots(env.plugin)
    slots.restore()
    slots.releaseUnclaimed()

    expect(env.removeRibbonAction).toHaveBeenCalledWith('yolo:Learning')
    expect(env.storage()).toEqual({})
  })

  it('keeps the declaration on unbind and drops it on forget', () => {
    const env = createPlugin()
    const slots = new ModuleRibbonSlots(env.plugin)
    slots.bind('learning', 'graduation-cap', 'Learning', jest.fn())

    slots.unbind('learning')
    expect(env.removeRibbonAction).toHaveBeenCalledWith('yolo:Learning')
    expect(env.storage()).toEqual({
      learning: { icon: 'graduation-cap', title: 'Learning' },
    })

    slots.forget('learning')
    expect(env.storage()).toEqual({})
  })
})
