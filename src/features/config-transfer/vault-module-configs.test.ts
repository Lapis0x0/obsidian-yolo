import {
  collectVaultModuleConfigs,
  findRootVaultDataJson,
} from './vault-module-configs'

const file = (webkitRelativePath: string, value: string) => ({
  webkitRelativePath,
  text: async () => value,
})

describe('vault module config collection', () => {
  const root = '我的库'
  const dataJson = `${root}/.obsidian/plugins/yolo/data.json`

  it('uses only a root-level plugin data.json', () => {
    const rootFile = file(dataJson, '{}')
    expect(
      findRootVaultDataJson([
        file(`${root}/backup/.obsidian/plugins/yolo/data.json`, '{}'),
        rootFile,
      ]),
    ).toBe(rootFile)
  })

  it('prefers current yolo config over legacy config in reverse FileList order', () => {
    const current = file(dataJson, '{}')
    expect(
      findRootVaultDataJson([
        file(`${root}/.obsidian/plugins/obsidian-yolo/data.json`, '{}'),
        current,
      ]),
    ).toBe(current)
  })

  it('collects immediate module envelopes at a multi-segment baseDir only', async () => {
    const configs = await collectVaultModuleConfigs(
      [
        file(dataJson, '{}'),
        file(
          `${root}/配置/YOLO/.yolo_json_db/module-settings/learning.json`,
          '{"schemaVersion":1,"data":{"modelId":"a"}}',
        ),
        file(
          `${root}/配置/YOLO/.yolo_json_db/module-settings/nested/ignored.json`,
          '{"schemaVersion":1,"data":{}}',
        ),
      ],
      dataJson,
      { yolo: { baseDir: '配置/YOLO' } },
    )
    expect(configs).toEqual({
      learning: { schemaVersion: 1, data: { modelId: 'a' } },
    })
  })

  it('rejects invalid envelopes', async () => {
    await expect(
      collectVaultModuleConfigs(
        [
          file(dataJson, '{}'),
          file(
            `${root}/YOLO/.yolo_json_db/module-settings/learning.json`,
            '{"schemaVersion":-1,"data":{}}',
          ),
        ],
        dataJson,
        { yolo: { baseDir: 'YOLO' } },
      ),
    ).rejects.toThrow('invalid')
  })
})
