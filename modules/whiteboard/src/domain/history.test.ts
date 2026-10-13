import { type BoardNode } from './fileFormat'
import { BoardHistory } from './history'
import type { BoardChanges } from './portals'

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
