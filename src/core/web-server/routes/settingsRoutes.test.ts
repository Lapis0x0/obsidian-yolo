import { WebRouter } from '../WebRouter'
import { registerSettingsRoutes } from './settingsRoutes'

describe('settingsRoutes', () => {
  let router: WebRouter
  let jsonMock: jest.Mock
  let readJsonMock: jest.Mock
  let setSettingsMock: jest.Mock

  beforeEach(() => {
    router = new WebRouter()
    jsonMock = jest.fn()
    readJsonMock = jest.fn()
    setSettingsMock = jest.fn()

    const ctx = {
      plugin: {
        settings: { version: 50, chatModelId: 'gpt-4' },
        setSettings: setSettingsMock,
      },
      server: { router, json: jsonMock, readJson: readJsonMock },
    } as any

    registerSettingsRoutes(ctx)
  })

  describe('GET /api/settings', () => {
    it('returns current settings', () => {
      const handler = router.resolve('GET', '/api/settings')

      expect(handler).not.toBeNull()
      handler!.handler({} as any, {} as any, handler!.params)

      expect(jsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
        version: 50,
        chatModelId: 'gpt-4',
      })
    })
  })

  describe('POST /api/settings/update', () => {
    it('updates settings and returns new value', async () => {
      readJsonMock.mockResolvedValue({ version: 50, chatModelId: 'claude-4' })
      setSettingsMock.mockResolvedValue(undefined)

      const handler = router.resolve('POST', '/api/settings/update')

      expect(handler).not.toBeNull()
      await handler!.handler(
        { url: '/api/settings/update' } as any,
        {} as any,
        handler!.params,
      )

      expect(setSettingsMock).toHaveBeenCalledWith({
        version: 50,
        chatModelId: 'claude-4',
      })
      expect(jsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
        version: 50,
        chatModelId: 'gpt-4',
      })
    })

    it('returns 400 on invalid JSON body', async () => {
      readJsonMock.mockRejectedValue(new Error('Invalid JSON'))

      const handler = router.resolve('POST', '/api/settings/update')

      expect(handler).not.toBeNull()
      await handler!.handler(
        { url: '/api/settings/update' } as any,
        {} as any,
        handler!.params,
      )

      expect(jsonMock).toHaveBeenCalledWith(expect.anything(), 400, {
        error: 'Invalid settings payload',
      })
    })
  })
})
