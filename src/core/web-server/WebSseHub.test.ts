import { ServerResponse } from 'http'
import { Writable } from 'stream'
import { WebSseHub } from './WebSseHub'

function createMockRes(): ServerResponse {
  const writable = new Writable({
    write(chunk: any, _encoding: any, callback: () => void) {
      callback()
    },
  })
  return Object.assign(writable, {
    writeHead: jest.fn().mockReturnThis(),
    end: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(),
    setTimeout: jest.fn(),
    statusCode: 200,
    setHeader: jest.fn(),
    getHeader: jest.fn(),
    headersSent: false,
  }) as unknown as ServerResponse
}

describe('WebSseHub', () => {
  let hub: WebSseHub

  beforeEach(() => {
    hub = new WebSseHub()
  })

  describe('add', () => {
    it('adds a connection and returns an unsubscribe function', () => {
      const res = createMockRes()
      const unsubscribe = hub.add('conv-1', res)

      expect(typeof unsubscribe).toBe('function')
    })

    it('allows multiple connections for the same conversation', () => {
      const res1 = createMockRes()
      const res2 = createMockRes()
      hub.add('conv-1', res1)
      hub.add('conv-1', res2)

      const spy1 = jest.spyOn(res1, 'write')
      const spy2 = jest.spyOn(res2, 'write')

      hub.send('conv-1', 'state', { status: 'running' })

      expect(spy1).toHaveBeenCalledTimes(1)
      expect(spy2).toHaveBeenCalledTimes(1)
    })
  })

  describe('send', () => {
    it('writes SSE-formatted data to all connections', () => {
      const res = createMockRes()
      const writeSpy = jest.spyOn(res, 'write')
      hub.add('conv-1', res)

      hub.send('conv-1', 'state', { status: 'running' })

      expect(writeSpy).toHaveBeenCalledWith(
        'event: state\ndata: {"status":"running"}\n\n',
      )
    })

    it('does nothing for unknown conversation', () => {
      expect(() => hub.send('unknown', 'state', {})).not.toThrow()
    })

    it('handles write errors gracefully', () => {
      const res = createMockRes()
      jest.spyOn(res, 'write').mockImplementation(() => {
        throw new Error('write error')
      })
      hub.add('conv-1', res)

      expect(() => hub.send('conv-1', 'state', {})).not.toThrow()
    })
  })

  describe('unsubscribe', () => {
    it('removes a connection so it no longer receives events', () => {
      const res = createMockRes()
      const unsubscribe = hub.add('conv-1', res)
      const writeSpy = jest.spyOn(res, 'write')

      unsubscribe()
      hub.send('conv-1', 'state', {})

      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('does not affect other connections when unsubscribing one', () => {
      const res1 = createMockRes()
      const res2 = createMockRes()
      const unsub1 = hub.add('conv-1', res1)
      hub.add('conv-1', res2)
      const spy1 = jest.spyOn(res1, 'write')
      const spy2 = jest.spyOn(res2, 'write')

      unsub1()
      hub.send('conv-1', 'state', {})

      expect(spy1).not.toHaveBeenCalled()
      expect(spy2).toHaveBeenCalledTimes(1)
    })
  })

  describe('remove', () => {
    it('removes all connections for a conversation', () => {
      const res = createMockRes()
      const writeSpy = jest.spyOn(res, 'write')
      hub.add('conv-1', res)
      hub.remove('conv-1')

      hub.send('conv-1', 'state', {})

      expect(writeSpy).not.toHaveBeenCalled()
    })
  })

  describe('disconnectAll', () => {
    it('removes all connections across all conversations', () => {
      const res1 = createMockRes()
      const res2 = createMockRes()
      const spy1 = jest.spyOn(res1, 'write')
      const spy2 = jest.spyOn(res2, 'write')
      hub.add('conv-1', res1)
      hub.add('conv-2', res2)

      hub.disconnectAll()
      hub.send('conv-1', 'state', {})
      hub.send('conv-2', 'state', {})

      expect(spy1).not.toHaveBeenCalled()
      expect(spy2).not.toHaveBeenCalled()
    })
  })
})
