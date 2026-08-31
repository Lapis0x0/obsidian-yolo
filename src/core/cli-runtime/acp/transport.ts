import { loadDesktopNodeModule } from '../../../utils/platform/desktopNodeModule'

import type { AcpProcessLike } from './process'

/**
 * `Readable.toWeb`/`Writable.toWeb` (stable since Node 18) postdate this
 * repo's pinned `@types/node@16`, so `typeof import('node:stream')` doesn't
 * declare them even though the Electron runtime has them. Narrow local shape
 * instead of bumping a shared, wide-blast-radius type dependency for it.
 */
type NodeStreamWebInterop = {
  Readable: {
    toWeb(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array>
  }
  Writable: {
    toWeb(stream: NodeJS.WritableStream): WritableStream<Uint8Array>
  }
}

/**
 * Bridges a child process's raw stdio into the ACP SDK's byte-level `Stream`
 * type (newline-delimited JSON over Web Streams — `@agentclientprotocol/sdk`
 * 1.3.0, protocol v1). Node's `Readable`/`Writable` `toWeb()` adapters do the
 * byte-stream conversion; the SDK's `ndJsonStream` does NDJSON framing on top.
 */
export const createAcpStream = async (
  process: AcpProcessLike,
): Promise<import('@agentclientprotocol/sdk').Stream> => {
  const [{ ndJsonStream }, { Readable, Writable }] = await Promise.all([
    import('@agentclientprotocol/sdk'),
    loadDesktopNodeModule<NodeStreamWebInterop>('node:stream'),
  ])
  return ndJsonStream(
    Writable.toWeb(process.stdin),
    Readable.toWeb(process.stdout),
  )
}
