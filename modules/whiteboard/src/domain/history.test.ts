import { type Board, emptyBoard } from './fileFormat'
import { BoardHistory } from './history'

function board(tag: string): Board {
  return { ...emptyBoard(), extra: { tag } }
}

describe('BoardHistory', () => {
  it('has nothing to undo at a fresh reset', () => {
    const history = new BoardHistory()
    history.reset(board('a'))
    expect(history.canUndo()).toBe(false)
    expect(history.canRedo()).toBe(false)
    expect(history.undo()).toBeNull()
  })

  it('walks back and forward through pushed states', () => {
    const [a, b, c] = [board('a'), board('b'), board('c')]
    const history = new BoardHistory()
    history.reset(a)
    history.push(b)
    history.push(c)

    expect(history.undo()).toBe(b)
    expect(history.undo()).toBe(a)
    expect(history.undo()).toBeNull()
    expect(history.redo()).toBe(b)
    expect(history.redo()).toBe(c)
    expect(history.redo()).toBeNull()
  })

  it('drops the redo tail once a new state is pushed after an undo', () => {
    const [a, b, c] = [board('a'), board('b'), board('c')]
    const history = new BoardHistory()
    history.reset(a)
    history.push(b)
    history.undo()
    history.push(c)

    expect(history.canRedo()).toBe(false)
    expect(history.undo()).toBe(a)
    expect(history.redo()).toBe(c)
  })

  it('ignores a push of the state already on top', () => {
    const a = board('a')
    const history = new BoardHistory()
    history.reset(a)
    history.push(a)
    expect(history.canUndo()).toBe(false)
  })

  it('coalesces successive pushes carrying the same key into one step', () => {
    const [a, b, c] = [board('a'), board('b'), board('c')]
    const history = new BoardHistory()
    history.reset(a)
    history.push(b, 'edit-1')
    history.push(c, 'edit-1')

    // One editing session, one step back — landing before the session, not
    // between two of its throttled writes.
    expect(history.undo()).toBe(a)
    expect(history.redo()).toBe(c)
  })

  it('starts a new step for a different key', () => {
    const [a, b, c] = [board('a'), board('b'), board('c')]
    const history = new BoardHistory()
    history.reset(a)
    history.push(b, 'edit-1')
    history.push(c, 'edit-2')

    expect(history.undo()).toBe(b)
  })

  it('does not coalesce into an entry that undo/redo has moved back onto', () => {
    const [a, b, c] = [board('a'), board('b'), board('c')]
    const history = new BoardHistory()
    history.reset(a)
    history.push(b, 'edit-1')
    history.undo()
    history.redo()
    history.push(c, 'edit-1')

    expect(history.undo()).toBe(b)
  })

  it('forgets the oldest state past its limit', () => {
    const boards = Array.from({ length: 5 }, (_, i) => board(String(i)))
    const history = new BoardHistory(3)
    history.reset(boards[0])
    for (const entry of boards.slice(1)) history.push(entry)

    expect(history.undo()).toBe(boards[3])
    expect(history.undo()).toBe(boards[2])
    expect(history.undo()).toBeNull()
  })

  it('drops everything a reset supersedes', () => {
    const [a, b, fresh] = [board('a'), board('b'), board('fresh')]
    const history = new BoardHistory()
    history.reset(a)
    history.push(b)
    history.reset(fresh)

    expect(history.canUndo()).toBe(false)
    expect(history.canRedo()).toBe(false)
  })
})
