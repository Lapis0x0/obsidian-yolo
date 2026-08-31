/* eslint-disable import/no-nodejs-modules -- exercises the desktop-only pi process boundary */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
/* eslint-enable import/no-nodejs-modules */

import { PiSubprocess } from './process'

jest.mock('shell-env', () => ({ shellEnvSync: () => ({}) }))

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  killed = false
  kill(): void {
    this.killed = true
  }
}

let fakeChild: FakeChildProcess | undefined

// `loadDesktopNodeModule` resolves Node builtins via Obsidian's desktop
// `require` at runtime; route it through Jest's own loader for real modules
// (`node:string_decoder`) and hand back a scriptable fake for
// `node:child_process`'s `spawn`, same pattern as the ACP transport tests.
jest.mock('../../../utils/platform/desktopNodeModule', () => ({
  loadDesktopNodeModule: async (specifier: string) => {
    if (specifier === 'node:child_process') {
      return {
        spawn: () => {
          fakeChild = new FakeChildProcess()
          queueMicrotask(() => fakeChild?.emit('spawn'))
          return fakeChild
        },
      }
    }
    return jest.requireActual(specifier) as unknown
  },
}))

describe('PiSubprocess — stdout decoding', () => {
  it('reassembles a multi-byte UTF-8 character split across two stdout chunks', async () => {
    const process = await PiSubprocess.start({
      command: 'pi',
      args: ['--mode', 'rpc'],
      cwd: '/vault',
    })
    const chunks: string[] = []
    process.onData((chunk) => chunks.push(chunk))

    const payloadText = '{"type":"message_update","text":"日本語"}\n'
    const payload = Buffer.from(payloadText, 'utf8')
    // '日' (U+65E5) is the first non-ASCII character in the payload and
    // encodes to 3 UTF-8 bytes — cut the chunk one byte into that sequence
    // so neither half is a valid standalone UTF-8 string.
    const prefixBytes = Buffer.byteLength(
      '{"type":"message_update","text":"',
      'utf8',
    )
    const splitAt = prefixBytes + 1

    fakeChild?.stdout.write(payload.subarray(0, splitAt))
    fakeChild?.stdout.write(payload.subarray(splitAt))
    await new Promise((resolve) => setImmediate(resolve))

    const received = chunks.join('')
    expect(received).toBe(payloadText)
    expect(received).not.toContain('�')
    const parsed = JSON.parse(received.trim()) as { text: string }
    expect(parsed.text).toBe('日本語')
  })

  it('does not corrupt plain ASCII chunk boundaries', async () => {
    const process = await PiSubprocess.start({
      command: 'pi',
      args: [],
      cwd: '/vault',
    })
    const chunks: string[] = []
    process.onData((chunk) => chunks.push(chunk))

    fakeChild?.stdout.write(Buffer.from('{"type":"a', 'utf8'))
    fakeChild?.stdout.write(Buffer.from('gent_settled"}\n', 'utf8'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(chunks.join('')).toBe('{"type":"agent_settled"}\n')
  })

  it('flushes a trailing incomplete sequence on stdout end', async () => {
    const process = await PiSubprocess.start({
      command: 'pi',
      args: [],
      cwd: '/vault',
    })
    const chunks: string[] = []
    process.onData((chunk) => chunks.push(chunk))

    // A lone leading byte of a 3-byte UTF-8 sequence, with the stream ending
    // before the rest ever arrives — `StringDecoder.end()` must flush it
    // (as a replacement character) instead of silently dropping it.
    fakeChild?.stdout.write(Buffer.from([0xe6]))
    fakeChild?.stdout.end()
    await new Promise((resolve) => setImmediate(resolve))

    expect(chunks.join('')).toBe('�')
  })
})
