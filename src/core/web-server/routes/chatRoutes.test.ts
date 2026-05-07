import { createObsidianRuntimeChat } from '../../../runtime/obsidian/obsidianRuntimeChat'
import { WebRouter } from '../WebRouter'
import { registerChatRoutes } from './chatRoutes'

jest.mock('../../../runtime/obsidian/obsidianRuntimeChat', () => ({
  createObsidianRuntimeChat: jest.fn(),
}))

const mockCreateObsidianRuntimeChat =
  createObsidianRuntimeChat as jest.MockedFunction<
    typeof createObsidianRuntimeChat
  >

describe('chatRoutes', () => {
  let router: WebRouter
  let jsonMock: jest.Mock
  let readJsonMock: jest.Mock
  let updateTitleMock: jest.Mock

  beforeEach(() => {
    router = new WebRouter()
    jsonMock = jest.fn()
    readJsonMock = jest.fn()
    updateTitleMock = jest.fn()

    mockCreateObsidianRuntimeChat.mockReturnValue({
      list: jest.fn(),
      get: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
      togglePinned: jest.fn(),
      updateTitle: updateTitleMock,
      generateTitle: jest.fn(),
    } as any)

    const ctx = {
      plugin: {
        app: {},
        settings: {},
      },
      server: { router, json: jsonMock, readJson: readJsonMock },
    } as any

    registerChatRoutes(ctx)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('registers POST /api/chat/update-title and forwards touchUpdatedAt to runtime.chat', async () => {
    readJsonMock.mockResolvedValue({
      id: 'chat-1',
      title: 'Renamed',
      touchUpdatedAt: false,
    })

    const handler = router.resolve('POST', '/api/chat/update-title')

    expect(handler).not.toBeNull()
    await handler!.handler(
      { url: '/api/chat/update-title' } as any,
      {} as any,
      handler!.params,
    )

    expect(updateTitleMock).toHaveBeenCalledWith('chat-1', 'Renamed', {
      touchUpdatedAt: false,
    })
    expect(jsonMock).toHaveBeenCalledWith(expect.anything(), 200, { ok: true })
  })
})
