import {
  type Board,
  type BoardNode,
  emptyBoard,
  parseBoard,
  serializeBoard,
} from '../domain/fileFormat'
import type { FileChanges } from '../domain/portals'

import { BoardDocuments } from './boardDocuments'

const card = (id: string, text: string): BoardNode => ({
  id,
  type: 'text',
  x: 0,
  y: 0,
  w: 100,
  h: 50,
  text,
  extra: {},
})
const boardText = (nodes: BoardNode[]) =>
  serializeBoard({ ...emptyBoard(), nodes } satisfies Board)
const textOf = (content: string | undefined, id: string) => {
  const parsed = content === undefined ? null : parseBoard(content)
  if (!parsed?.ok) return null
  const node = parsed.board.nodes.find((known) => known.id === id)
  return node?.type === 'text' ? node.text : null
}
/** `id`'s text changed from `before` to `after`. */
const retext = (id: string, before: string, after: string): FileChanges => ({
  nodes: new Map([
    [id, { before: card(id, before), after: card(id, after), index: 0 }],
  ]),
  edges: new Map(),
})

type Snapshot = { path: string; content: string }

function fakeHost(files: Map<string, string>) {
  const reads: string[] = []
  const host = {
    vault: {
      readTextSnapshot: (path: string): Promise<Snapshot | null> => {
        reads.push(path)
        const content = files.get(path)
        return Promise.resolve(content === undefined ? null : { path, content })
      },
      replaceTextIfUnchanged: (
        expected: Snapshot,
        content: string,
      ): Promise<Snapshot | null> => {
        if (files.get(expected.path) !== expected.content) {
          return Promise.resolve(null)
        }
        files.set(expected.path, content)
        return Promise.resolve({ path: expected.path, content })
      },
      createTextIfAbsent: (
        path: string,
        content: string,
      ): Promise<Snapshot | null> => {
        if (files.has(path)) return Promise.resolve(null)
        files.set(path, content)
        return Promise.resolve({ path, content })
      },
      subscribe: () => () => undefined,
    },
  }
  return { host: host as unknown as YoloModuleHostApiV1, reads }
}

/** Lets every pending promise, and what each schedules, run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('BoardDocuments', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('writes a change a moment later, over the file as it was read', async () => {
    const files = new Map([['sub.yoloboard', boardText([card('a', 'one')])]])
    const documents = new BoardDocuments(fakeHost(files).host, jest.fn())
    const document = documents.acquire('sub.yoloboard')
    await settle()
    document.apply(retext('a', 'one', 'two'), null)
    expect(textOf(files.get('sub.yoloboard'), 'a')).toBe('one')
    jest.advanceTimersByTime(1000)
    await settle()
    expect(textOf(files.get('sub.yoloboard'), 'a')).toBe('two')
  })

  it('keeps what is done to it before it is read, and writes it once it is', async () => {
    const files = new Map([
      ['sub.yoloboard', boardText([card('a', 'one'), card('b', 'kept')])],
    ])
    const documents = new BoardDocuments(fakeHost(files).host, jest.fn())
    const document = documents.acquire('sub.yoloboard')
    document.apply(retext('a', 'one', 'two'), null)
    await settle()
    expect(textOf(serializeBoard(document.board!), 'a')).toBe('two')
    jest.advanceTimersByTime(1000)
    await settle()
    expect(textOf(files.get('sub.yoloboard'), 'a')).toBe('two')
    expect(textOf(files.get('sub.yoloboard'), 'b')).toBe('kept')
  })

  it('puts its changes on what the file became meanwhile', async () => {
    const files = new Map([
      ['sub.yoloboard', boardText([card('a', 'one'), card('b', 'old')])],
    ])
    const documents = new BoardDocuments(fakeHost(files).host, jest.fn())
    const document = documents.acquire('sub.yoloboard')
    await settle()
    document.apply(retext('a', 'one', 'two'), null)
    // Synced in from elsewhere before the write.
    files.set('sub.yoloboard', boardText([card('a', 'one'), card('b', 'new')]))
    jest.advanceTimersByTime(1000)
    await settle()
    jest.advanceTimersByTime(1000)
    await settle()
    expect(textOf(files.get('sub.yoloboard'), 'a')).toBe('two')
    expect(textOf(files.get('sub.yoloboard'), 'b')).toBe('new')
  })

  it('leaves the writing to the view that owns it', async () => {
    const files = new Map([['sub.yoloboard', boardText([card('a', 'one')])]])
    const { host, reads } = fakeHost(files)
    const documents = new BoardDocuments(host, jest.fn())
    const document = documents.acquire('sub.yoloboard')
    const requestSave = jest.fn()
    document.own({ requestSave })
    document.loadText(files.get('sub.yoloboard')!, 'view')
    document.apply(retext('a', 'one', 'two'), null)
    jest.advanceTimersByTime(1000)
    await settle()
    expect(requestSave).toHaveBeenCalledTimes(1)
    expect(textOf(files.get('sub.yoloboard'), 'a')).toBe('one')
    // The view read the file: owned as it was acquired, it is not read again.
    expect(reads).toEqual([])
  })

  it('is one document however many hold it, read once', async () => {
    const files = new Map([['sub.yoloboard', boardText([card('a', 'one')])]])
    const { host, reads } = fakeHost(files)
    const documents = new BoardDocuments(host, jest.fn())
    const first = documents.acquire('sub.yoloboard')
    const second = documents.acquire('sub.yoloboard')
    await settle()
    expect(second).toBe(first)
    expect(reads).toEqual(['sub.yoloboard'])
  })
})
