import {
  type RevealPhase,
  type RevealSegment,
  createStreamingRevealPlugin,
} from './streamingReveal'

type TestNode = {
  type: string
  tagName?: string
  value?: string
  children?: TestNode[]
  position?: { start?: { offset?: number }; end?: { offset?: number } }
  properties?: Record<string, unknown>
}

function text(value: string, start: number, end = start + value.length) {
  return {
    type: 'text',
    value,
    position: { start: { offset: start }, end: { offset: end } },
  }
}

function element(tagName: string, children: TestNode[]): TestNode {
  return { type: 'element', tagName, children }
}

function run(
  tree: TestNode,
  segments: RevealSegment[],
  phase: RevealPhase = 0,
): TestNode {
  createStreamingRevealPlugin(segments, phase)()(tree as never)
  return tree
}

function isRevealSpan(node: TestNode): boolean {
  const className = node.properties?.className
  return Array.isArray(className) && className.includes('yolo-stream-reveal')
}

function revealedText(node: TestNode): string {
  if (node.type === 'text') {
    return ''
  }
  if (isRevealSpan(node)) {
    return node.children?.map((child) => child.value ?? '').join('') ?? ''
  }
  return node.children?.map(revealedText).join('') ?? ''
}

function plainText(node: TestNode): string {
  if (node.type === 'text') {
    return node.value ?? ''
  }
  if (isRevealSpan(node)) {
    return ''
  }
  return node.children?.map(plainText).join('') ?? ''
}

function spans(node: TestNode): { value: string; style: unknown }[] {
  if (isRevealSpan(node)) {
    return [
      {
        value: node.children?.[0]?.value ?? '',
        style: node.properties?.style,
      },
    ]
  }
  return node.children?.flatMap(spans) ?? []
}

function style(phase: 'a' | 'b', delayMs: number): string {
  return `animation-name:yolo-stream-reveal-${phase};animation-delay:-${delayMs}ms`
}

describe('createStreamingRevealPlugin', () => {
  it('wraps only the characters inside the fade window', () => {
    const tree = element('root', [element('p', [text('Hello world', 0)])])

    run(tree, [{ from: 6, ageMs: 100 }])

    expect(plainText(tree)).toBe('Hello ')
    expect(revealedText(tree)).toBe('world')
  })

  it('wraps a segment as one span, whatever the script', () => {
    const tree = element('root', [element('p', [text('你好世界', 0)])])

    run(tree, [{ from: 2, ageMs: 100 }])

    expect(spans(tree)).toEqual([{ value: '世界', style: style('a', 100) }])
  })

  it('phases each span by its segment age and the frame parity', () => {
    const tree = element('root', [element('p', [text('abcdef', 0)])])

    run(
      tree,
      [
        { from: 2, ageMs: 66.7 },
        { from: 4, ageMs: 33.3 },
      ],
      1,
    )

    expect(plainText(tree)).toBe('ab')
    expect(spans(tree)).toEqual([
      { value: 'cd', style: style('b', 67) },
      { value: 'ef', style: style('b', 33) },
    ])
  })

  it('carries segments across element boundaries', () => {
    const tree = element('root', [
      element('p', [
        text('ab', 0),
        element('strong', [text('cd', 2)]),
        text('ef', 4),
      ]),
    ])

    run(tree, [
      { from: 1, ageMs: 90 },
      { from: 3, ageMs: 30 },
    ])

    expect(plainText(tree)).toBe('a')
    expect(spans(tree)).toEqual([
      { value: 'b', style: style('a', 90) },
      { value: 'c', style: style('a', 90) },
      { value: 'd', style: style('a', 30) },
      { value: 'ef', style: style('a', 30) },
    ])
  })

  it('leaves fully settled text untouched', () => {
    const tree = element('root', [element('p', [text('Settled', 0)])])

    run(tree, [{ from: 100, ageMs: 100 }])

    expect(plainText(tree)).toBe('Settled')
    expect(revealedText(tree)).toBe('')
  })

  it('renders plain when there is no fade window', () => {
    const tree = element('root', [element('p', [text('Settled', 0)])])

    run(tree, [])

    expect(plainText(tree)).toBe('Settled')
    expect(revealedText(tree)).toBe('')
  })

  it('does not reveal inside code or math subtrees', () => {
    const tree = element('root', [
      element('pre', [element('code', [text('const x = 1', 0)])]),
    ])

    run(tree, [{ from: 0, ageMs: 100 }])

    expect(revealedText(tree)).toBe('')
    expect(plainText(tree)).toBe('const x = 1')
  })

  it('reveals a node whole when source offsets disagree with its value', () => {
    // `&amp;` occupies five source characters but one text character; slicing
    // at a source offset would cut in the wrong place.
    const tree = element('root', [element('p', [text('&', 10, 15)])])

    run(tree, [{ from: 12, ageMs: 60 }])

    expect(spans(tree)).toEqual([{ value: '&', style: style('a', 60) }])
  })

  it('reveals a whole node that starts inside the window', () => {
    const tree = element('root', [element('p', [text('abc', 10)])])

    run(tree, [{ from: 5, ageMs: 70 }])

    expect(spans(tree)).toEqual([{ value: 'abc', style: style('a', 70) }])
    expect(plainText(tree)).toBe('')
  })
})
