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
