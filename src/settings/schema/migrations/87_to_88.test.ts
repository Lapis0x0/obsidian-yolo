import { migrateFrom87To88 } from './87_to_88'

describe('migrateFrom87To88', () => {
  it('turns a disabled update notice into the off mode', () => {
    expect(
      migrateFrom87To88({
        version: 87,
        pluginUpdateNoticeEnabled: false,
        pluginUpdateAutoDownloadEnabled: true,
      }),
    ).toEqual({ version: 88, pluginUpdateMode: 'off' })
  })

  it('keeps everyone else on notify, whatever the download toggle was', () => {
    expect(
      migrateFrom87To88({
        version: 87,
        pluginUpdateNoticeEnabled: true,
        pluginUpdateAutoDownloadEnabled: false,
      }),
    ).toEqual({ version: 88, pluginUpdateMode: 'notify' })
    expect(migrateFrom87To88({ version: 87 })).toEqual({
      version: 88,
      pluginUpdateMode: 'notify',
    })
  })
})

describe('migrateFrom87To88 auto context compaction', () => {
  it('moves users still on the old defaults to the new ones', () => {
    expect(
      migrateFrom87To88({
        version: 87,
        chatOptions: {
          chatMode: 'agent',
          autoContextCompactionEnabled: false,
          autoContextCompactionThresholdMode: 'tokens',
          autoContextCompactionThresholdTokens: 100000,
          autoContextCompactionThresholdRatio: 0.8,
        },
      }).chatOptions,
    ).toEqual({
      chatMode: 'agent',
      autoContextCompactionEnabled: true,
      autoContextCompactionThresholdRatio: 0.9,
    })
  })

  it('keeps a user-chosen toggle or ratio and drops the removed fields', () => {
    expect(
      migrateFrom87To88({
        version: 87,
        chatOptions: {
          autoContextCompactionEnabled: true,
          autoContextCompactionThresholdMode: 'tokens',
          autoContextCompactionThresholdTokens: 50000,
          autoContextCompactionThresholdRatio: 0.8,
        },
      }).chatOptions,
    ).toEqual({
      autoContextCompactionEnabled: true,
      autoContextCompactionThresholdRatio: 0.8,
    })
    expect(
      migrateFrom87To88({
        version: 87,
        chatOptions: {
          autoContextCompactionEnabled: false,
          autoContextCompactionThresholdRatio: 0.7,
        },
      }).chatOptions,
    ).toEqual({
      autoContextCompactionEnabled: false,
      autoContextCompactionThresholdRatio: 0.7,
    })
  })
})
