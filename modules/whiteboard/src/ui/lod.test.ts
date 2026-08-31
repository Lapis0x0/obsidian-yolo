import type { FileNode, GroupNode, TextNode } from '../domain/fileFormat'

import { DEGRADE_RESTORE_SCALE, DEGRADE_SCALE_THRESHOLD } from './constants'
import { degradedNodeTitle, nextDegradedState } from './lod'

describe('nextDegradedState', () => {
  const band = { enter: 0.35, restore: 0.42 }

  it('degrades once the scale drops below the enter threshold', () => {
    expect(nextDegradedState(0.2, false, band)).toBe(true)
  })

  it('stays undegraded at or above the enter threshold', () => {
    expect(nextDegradedState(0.35, false, band)).toBe(false)
    expect(nextDegradedState(1, false, band)).toBe(false)
  })

  it('stays degraded inside the band — a scale that only just cleared the enter threshold does not rebuild content', () => {
    expect(nextDegradedState(0.36, true, band)).toBe(true)
    expect(nextDegradedState(0.41, true, band)).toBe(true)
  })

  it('restores once the scale clears the far side of the band', () => {
    expect(nextDegradedState(0.42, true, band)).toBe(false)
    expect(nextDegradedState(1, true, band)).toBe(false)
  })

  it('is driven by a band the constants actually leave open', () => {
    expect(DEGRADE_RESTORE_SCALE).toBeGreaterThan(DEGRADE_SCALE_THRESHOLD)
  })
})

function fileNode(file: string): FileNode {
  return { id: 'c1', type: 'file', x: 0, y: 0, w: 100, h: 100, file, extra: {} }
}

function textCard(text: string): TextNode {
  return { id: 'c3', type: 'text', x: 0, y: 0, w: 100, h: 100, text, extra: {} }
}

function groupNode(label?: string): GroupNode {
  return {
    id: 'g1',
    type: 'group',
    x: 0,
    y: 0,
    w: 400,
    h: 400,
    ...(label === undefined ? {} : { label }),
    extra: {},
  }
}

describe('degradedNodeTitle', () => {
  it('shows a markdown file node basename', () => {
    expect(degradedNodeTitle(fileNode('Cards/概念A.md'))).toBe('概念A')
  })

  it('shows any other file node basename the same way', () => {
    expect(degradedNodeTitle(fileNode('papers/foo.pdf'))).toBe('foo')
  })

  it('shows a group label, and nothing for an unlabelled group', () => {
    expect(degradedNodeTitle(groupNode('研究'))).toBe('研究')
    expect(degradedNodeTitle(groupNode())).toBe('')
  })

  it('shows a text node first line, trimmed', () => {
    expect(degradedNodeTitle(textCard('  hello world  \nsecond line'))).toBe(
      'hello world',
    )
  })

  it('shows the whole text when it has no newline', () => {
    expect(degradedNodeTitle(textCard('single line'))).toBe('single line')
  })

  it('drops a leading heading marker — the line is shown as a title, not as markdown', () => {
    expect(degradedNodeTitle(textCard('# 测试\n\nbody'))).toBe('测试')
    expect(degradedNodeTitle(textCard('###### deep'))).toBe('deep')
  })

  it('keeps markers that are not headings, and a hash that is not one', () => {
    expect(degradedNodeTitle(textCard('- 买牛奶'))).toBe('- 买牛奶')
    expect(degradedNodeTitle(textCard('#tag 起头'))).toBe('#tag 起头')
  })

  it('truncates a long text node first line', () => {
    const long = 'x'.repeat(100)
    const title = degradedNodeTitle(textCard(long))
    expect(title.length).toBe(60)
    expect(title.endsWith('…')).toBe(true)
  })
})
