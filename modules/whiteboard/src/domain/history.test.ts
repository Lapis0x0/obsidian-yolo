import { type Board, type BoardNode, emptyBoard } from './fileFormat'
import { BoardHistory, keepPageMemory } from './history'
import { boardWithPageMemory, removeNode, updateNode } from './operations'
import { type BoardChanges, applyChanges } from './portals'

const node = (id: string, x: number): BoardNode => ({
  id,
  type: 'text',
  x,
  y: 0,
  w: 10,
  h: 10,
  text: '',
  extra: {},
})

/** A step moving `id` in `file` from `from` to `to`. */
function step(id: string, from: number, to: number, file = 'a'): BoardChanges {
  return new Map([
    [
      file,
      {
        nodes: new Map([
          [id, { before: node(id, from), after: node(id, to), index: 0 }],
        ]),
        edges: new Map(),
      },
    ],
  ])
}

const xOf = (changes: BoardChanges | null, id: string, file = 'a') =>
  changes?.get(file)?.nodes.get(id)?.after?.x

describe('BoardHistory', () => {
  it('has nothing to undo at first', () => {
    const history = new BoardHistory()
    expect(history.canUndo()).toBe(false)
    expect(history.canRedo()).toBe(false)
    expect(history.undo()).toBeNull()
  })

  it('walks back and forward through the steps pushed', () => {
    const history = new BoardHistory()
    history.push(step('n', 0, 1))
    history.push(step('n', 1, 2))

    expect(xOf(history.undo(), 'n')).toBe(1)
    expect(xOf(history.undo(), 'n')).toBe(0)
    expect(history.undo()).toBeNull()
    expect(xOf(history.redo(), 'n')).toBe(1)
    expect(xOf(history.redo(), 'n')).toBe(2)
    expect(history.redo()).toBeNull()
  })

  it('drops the redo tail once a new step is pushed after an undo', () => {
    const history = new BoardHistory()
    history.push(step('n', 0, 1))
    history.undo()
    history.push(step('n', 0, 5))

    expect(history.canRedo()).toBe(false)
    expect(xOf(history.undo(), 'n')).toBe(0)
    expect(xOf(history.redo(), 'n')).toBe(5)
  })

  it('ignores a step that changes nothing', () => {
    const history = new BoardHistory()
    history.push(new Map())
    expect(history.canUndo()).toBe(false)
  })

  it('joins successive steps carrying the same key into one', () => {
    const history = new BoardHistory()
    history.push(step('n', 0, 1), 'edit-1')
    history.push(step('n', 1, 2), 'edit-1')
    history.push(step('m', 0, 9, 'b'), 'edit-1')

    // One editing session, one step back — landing before the session.
    const undone = history.undo()
    expect(xOf(undone, 'n')).toBe(0)
    expect(xOf(undone, 'm', 'b')).toBe(0)
    expect(history.canUndo()).toBe(false)
  })

  it('starts a new step for a different key', () => {
    const history = new BoardHistory()
    history.push(step('n', 0, 1), 'edit-1')
    history.push(step('n', 1, 2), 'edit-2')
    expect(xOf(history.undo(), 'n')).toBe(1)
  })

  it('does not join a step that undo has moved back past', () => {
    const history = new BoardHistory()
    history.push(step('n', 0, 1), 'edit-1')
    history.push(step('n', 1, 2), 'edit-2')
    history.undo()
    history.push(step('n', 1, 3), 'edit-2')
    expect(xOf(history.undo(), 'n')).toBe(1)
    expect(xOf(history.undo(), 'n')).toBe(0)
  })

  it('forgets the oldest step past its limit', () => {
    const history = new BoardHistory(2)
    history.push(step('n', 0, 1))
    history.push(step('n', 1, 2))
    history.push(step('n', 2, 3))
    history.undo()
    history.undo()
    expect(history.canUndo()).toBe(false)
  })

  it('drops everything a reset supersedes', () => {
    const history = new BoardHistory()
    history.push(step('n', 0, 1))
    history.undo()
    history.reset()
    expect(history.canUndo()).toBe(false)
    expect(history.canRedo()).toBe(false)
  })

  it('reports every change to what can be undone or redone', () => {
    const onChange = jest.fn()
    const history = new BoardHistory(undefined, onChange)
    history.push(step('n', 0, 1))
    history.undo()
    history.redo()
    history.reset()
    expect(onChange).toHaveBeenCalledTimes(4)
  })
})

describe('keepPageMemory', () => {
  const FILE = 'a'
  const page: BoardNode = {
    id: 'h',
    type: 'file',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    file: 'pages/demo.html',
    extra: {},
  }

  /** What going from `before` to `after` changed, as the history keeps it
   * (one file, nodes only). */
  const changesOf = (before: Board, after: Board): BoardChanges => {
    const nodes = new Map()
    const was = new Map(before.nodes.map((node) => [node.id, node]))
    after.nodes.forEach((node, index) => {
      if (was.get(node.id) !== node) {
        nodes.set(node.id, {
          before: was.get(node.id) ?? null,
          after: node,
          index,
        })
      }
    })
    before.nodes.forEach((node, index) => {
      if (!after.nodes.some((known) => known.id === node.id)) {
        nodes.set(node.id, { before: node, after: null, index })
      }
    })
    return new Map([[FILE, { nodes, edges: new Map() }]])
  }

  /** A board that records its edits, writes page memory outside them, and
   * undoes and redoes the way the canvas does. */
  const harness = (nodes: BoardNode[]) => {
    let board: Board = { ...emptyBoard(), nodes }
    const history = new BoardHistory()
    const replay = (changes: BoardChanges | null) => {
      if (!changes) return
      const kept = keepPageMemory(changes, (file, id) =>
        file === FILE ? board.nodes.find((node) => node.id === id) : undefined,
      )
      board = applyChanges(
        board,
        kept.get(FILE) ?? { nodes: new Map(), edges: new Map() },
      )
    }
    return {
      board: () => board,
      edit: (next: Board) => {
        history.push(changesOf(board, next))
        board = next
      },
      remember: (scroll: number, storage: Record<string, string>) => {
        board = boardWithPageMemory(board, 'h', { scroll, storage })
      },
      undo: () => replay(history.undo()),
      redo: () => replay(history.redo()),
      page: () => board.nodes.find((node) => node.id === 'h'),
    }
  }
  const memoryOf = (node: BoardNode | undefined) =>
    node?.type === 'file'
      ? { scroll: node.startScroll, storage: node.storage }
      : null

  it('leaves a page alone when another card’s edit is undone and redone', () => {
    const text = { ...page, id: 't', type: 'text', text: 'a' } as BoardNode
    const board = harness([page, text])
    board.remember(0.5, { a: '1' })
    const remembered = board.page()
    board.edit(updateNode(board.board(), 't', { x: 40 }))
    board.undo()
    expect(board.page()).toBe(remembered)
    board.redo()
    expect(board.page()).toBe(remembered)
  })

  it('keeps the memory a page has now through an undo and redo of its own edit', () => {
    const board = harness([page])
    board.remember(0.25, { a: '1' })
    board.edit(updateNode(board.board(), 'h', { x: 40 }))
    board.remember(0.5, { a: '2' })

    board.undo()
    expect(board.page()?.x).toBe(0)
    expect(memoryOf(board.page())).toEqual({ scroll: 0.5, storage: { a: '2' } })
    board.redo()
    expect(board.page()?.x).toBe(40)
    expect(memoryOf(board.page())).toEqual({ scroll: 0.5, storage: { a: '2' } })
  })

  it('gives back the very node the file has when memory was all a step changed', () => {
    const now: BoardNode = { ...page, startScroll: 0.5 }
    const stale: BoardNode = { ...page, startScroll: 0.1 }
    const changes: BoardChanges = new Map([
      [
        FILE,
        {
          nodes: new Map([['h', { before: page, after: stale, index: 0 }]]),
          edges: new Map(),
        },
      ],
    ])
    const kept = keepPageMemory(changes, () => now)
    expect(kept.get(FILE)?.nodes.get('h')?.after).toBe(now)
    // Nothing else is touched: no file node, no change.
    expect(keepPageMemory(changes, () => undefined)).toBe(changes)
  })

  it('brings a deleted page back with the memory it had when it was deleted', () => {
    const board = harness([page])
    board.remember(0.5, { a: '2' })
    board.edit(removeNode(board.board(), 'h'))
    expect(board.page()).toBeUndefined()
    board.undo()
    expect(memoryOf(board.page())).toEqual({ scroll: 0.5, storage: { a: '2' } })
  })
})
