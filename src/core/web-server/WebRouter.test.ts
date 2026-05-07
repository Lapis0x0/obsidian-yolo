import { WebRouter } from './WebRouter'

const mockRes = {} as any

describe('WebRouter', () => {
  let router: WebRouter

  beforeEach(() => {
    router = new WebRouter()
  })

  describe('basic routing', () => {
    it('matches a GET route', () => {
      const handler = jest.fn()
      router.get('/api/bootstrap', handler)

      const result = router.resolve('GET', '/api/bootstrap')

      expect(result).not.toBeNull()
      result!.handler({} as any, mockRes, result!.params)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('returns null for unmatched route', () => {
      const result = router.resolve('GET', '/api/not-found')
      expect(result).toBeNull()
    })

    it('does not match wrong method', () => {
      router.get('/api/bootstrap', jest.fn())

      expect(router.resolve('POST', '/api/bootstrap')).toBeNull()
      expect(router.resolve('GET', '/api/bootstrap')).not.toBeNull()
    })
  })

  describe('HTTP methods', () => {
    it.each(['get', 'post', 'put', 'delete'] as const)(
      'registers %s routes',
      (method) => {
        const handler = jest.fn()
        router[method]('/api/test', handler)

        const result = router.resolve(method.toUpperCase(), '/api/test')

        expect(result).not.toBeNull()
        result!.handler({} as any, mockRes, result!.params)
        expect(handler).toHaveBeenCalledTimes(1)
      },
    )
  })

  describe('path parameters', () => {
    it('extracts single path param', () => {
      const handler = jest.fn()
      router.get('/api/chat/get/:id', handler)

      const result = router.resolve('GET', '/api/chat/get/abc-123')

      expect(result).not.toBeNull()
      expect(result!.params).toEqual({ id: 'abc-123' })
      result!.handler({} as any, mockRes, result!.params)
      expect(handler).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { id: 'abc-123' },
      )
    })

    it('extracts multiple path params', () => {
      const handler = jest.fn()
      router.get('/api/:resource/:id', handler)

      const result = router.resolve('GET', '/api/chat/42')

      expect(result).not.toBeNull()
      expect(result!.params).toEqual({ resource: 'chat', id: '42' })
    })

    it('decodes URI-encoded params', () => {
      const handler = jest.fn()
      router.get('/api/chat/get/:id', handler)

      const result = router.resolve('GET', '/api/chat/get/hello%20world')

      expect(result).not.toBeNull()
      expect(result!.params).toEqual({ id: 'hello world' })
    })
  })

  describe('URL query string handling', () => {
    it('ignores query strings when matching routes', () => {
      const handler = jest.fn()
      router.get('/api/vault/read', handler)

      const result = router.resolve(
        'GET',
        '/api/vault/read?path=/test/file.md',
      )

      expect(result).not.toBeNull()
    })
  })

  describe('multiple routes', () => {
    it('matches correct route among many', () => {
      const handlerA = jest.fn()
      const handlerB = jest.fn()
      router.get('/api/a', handlerA)
      router.get('/api/b', handlerB)

      const resultB = router.resolve('GET', '/api/b')
      expect(resultB).not.toBeNull()
      resultB!.handler({} as any, mockRes, resultB!.params)
      expect(handlerA).not.toHaveBeenCalled()
      expect(handlerB).toHaveBeenCalledTimes(1)
    })
  })
})
