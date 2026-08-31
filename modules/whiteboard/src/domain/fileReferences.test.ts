import {
  type Board,
  type FileNode,
  type GroupNode,
  type TextNode,
  emptyBoard,
} from './fileFormat'
import { rewriteFileReferences } from './fileReferences'

function fileNode(id: string, file: string): FileNode {
  return { id, type: 'file', x: 0, y: 0, w: 100, h: 100, file, extra: {} }
}

function textNode(id: string, text = ''): TextNode {
  return { id, type: 'text', x: 0, y: 0, w: 100, h: 100, text, extra: {} }
}

function groupNode(id: string): GroupNode {
  return { id, type: 'group', x: 0, y: 0, w: 400, h: 400, extra: {} }
}

function boardWith(nodes: Board['nodes']): Board {
  return { ...emptyBoard(), nodes }
}

describe('rewriteFileReferences', () => {
  it('rewrites a matching markdown file node path', () => {
    const board = boardWith([fileNode('c1', 'old/path.md')])
    const next = rewriteFileReferences(board, 'old/path.md', 'new/path.md')
    expect(next).not.toBeNull()
    expect(next?.nodes[0]).toMatchObject({ file: 'new/path.md' })
  })

  it('rewrites a non-markdown file node path just the same', () => {
    const board = boardWith([fileNode('c1', 'old/paper.pdf')])
    const next = rewriteFileReferences(board, 'old/paper.pdf', 'new/paper.pdf')
    expect(next?.nodes[0]).toMatchObject({ file: 'new/paper.pdf' })
  })

  it('returns null when no node references the given path', () => {
    const board = boardWith([fileNode('c1', 'other.md')])
    expect(rewriteFileReferences(board, 'old.md', 'new.md')).toBeNull()
  })

  it('leaves untouched nodes referentially unchanged', () => {
    const c1 = fileNode('c1', 'old.md')
    const c2 = fileNode('c2', 'unrelated.md')
    const t1 = textNode('t1')
    const board = boardWith([c1, c2, t1])
    const next = rewriteFileReferences(board, 'old.md', 'new.md')
    expect(next?.nodes[1]).toBe(c2)
    expect(next?.nodes[2]).toBe(t1)
    expect(next?.nodes[0]).not.toBe(c1)
  })

  it('rewrites every node referencing the same old path', () => {
    const board = boardWith([
      fileNode('c1', 'shared.md'),
      fileNode('c2', 'shared.md'),
    ])
    const next = rewriteFileReferences(board, 'shared.md', 'moved.md')
    expect(next?.nodes[0]).toMatchObject({ file: 'moved.md' })
    expect(next?.nodes[1]).toMatchObject({ file: 'moved.md' })
  })

  it('never matches a text or group node (neither has a file field)', () => {
    const board = boardWith([textNode('t1'), groupNode('g1')])
    expect(rewriteFileReferences(board, 'old.md', 'new.md')).toBeNull()
  })
})
