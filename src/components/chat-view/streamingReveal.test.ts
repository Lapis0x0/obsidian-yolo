import { createStreamingRevealPlugin } from './streamingReveal'

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

function run(tree: TestNode, revealFrom: number): TestNode {
  createStreamingRevealPlugin(revealFrom)()(tree as never)
  return tree
}

function revealedText(node: TestNode): string {
  if (node.type === 'text') {
    return ''
  }
  const className = node.properties?.className
  if (Array.isArray(className) && className.includes('yolo-stream-reveal')) {
    return node.children?.map((child) => child.value ?? '').join('') ?? ''
  }
  return node.children?.map(revealedText).join('') ?? ''
}

function plainText(node: TestNode): string {
  if (node.type === 'text') {
    return node.value ?? ''
  }
  const className = node.properties?.className
  if (Array.isArray(className) && className.includes('yolo-stream-reveal')) {
    return ''
  }
  return node.children?.map(plainText).join('') ?? ''
}

describe('createStreamingRevealPlugin', () => {
  it('wraps only the characters past the reveal offset', () => {
    const tree = element('root', [element('p', [text('Hello world', 0)])])

    run(tree, 6)

    expect(plainText(tree)).toBe('Hello ')
    expect(revealedText(tree)).toBe('world')
  })

  it('wraps each character separately so CJK animates', () => {
    const tree = element('root', [element('p', [text('你好世界', 0)])])

    run(tree, 2)

    const spans: string[] = []
    const collect = (node: TestNode) => {
      const className = node.properties?.className
      if (
        Array.isArray(className) &&
        className.includes('yolo-stream-reveal')
      ) {
        spans.push(node.children?.[0]?.value ?? '')
        return
      }
      node.children?.forEach(collect)
    }
    collect(tree)

    expect(spans).toEqual(['世', '界'])
  })

  it('leaves fully settled text untouched', () => {
    const tree = element('root', [element('p', [text('Settled', 0)])])

    run(tree, 100)

    expect(plainText(tree)).toBe('Settled')
    expect(revealedText(tree)).toBe('')
  })

  it('does not animate inside code or math subtrees', () => {
    const tree = element('root', [
      element('pre', [element('code', [text('const x = 1', 0)])]),
    ])

    run(tree, 0)

    expect(revealedText(tree)).toBe('')
    expect(plainText(tree)).toBe('const x = 1')
  })

  it('animates a node whole when source offsets disagree with its value', () => {
    // `&amp;` occupies five source characters but one text character; slicing
    // at a source offset would cut in the wrong place.
    const tree = element('root', [element('p', [text('&', 10, 15)])])

    run(tree, 12)

    expect(revealedText(tree)).toBe('&')
  })

  it('animates the whole node when it starts past the offset', () => {
    const tree = element('root', [element('p', [text('abc', 10)])])

    run(tree, 5)

    expect(revealedText(tree)).toBe('abc')
    expect(plainText(tree)).toBe('')
  })
})
