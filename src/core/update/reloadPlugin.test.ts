import type { App } from 'obsidian'

import { reloadPlugin } from './reloadPlugin'

describe('reloadPlugin', () => {
  it('refreshes the cached manifest before loading the plugin again', async () => {
    const calls: string[] = []
    const plugins = {
      loadManifest: jest.fn(async (dir: string) => {
        calls.push(`loadManifest ${dir}`)
      }),
      disablePlugin: jest.fn(async (id: string) => {
        calls.push(`disablePlugin ${id}`)
      }),
      enablePlugin: jest.fn(async (id: string) => {
        calls.push(`enablePlugin ${id}`)
      }),
    }

    reloadPlugin(
      { plugins } as unknown as App,
      'yolo',
      'vault-config/plugins/yolo',
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls).toEqual([
      'loadManifest vault-config/plugins/yolo',
      'disablePlugin yolo',
      'enablePlugin yolo',
    ])
  })
})
