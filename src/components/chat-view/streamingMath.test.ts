import type { Root } from 'mdast'
import type { Math } from 'mdast-util-math'
import { finishRenderMath, renderMath } from 'obsidian'

import {
  markUnclosedDisplayMathNodes,
  normalizeDisplayMathDelimiters,
  renderStreamingMath,
} from './streamingMath'

const mockRenderMath = jest.mocked(renderMath)
const mockFinishRenderMath = jest.mocked(finishRenderMath)

describe('renderStreamingMath', () => {
  const animationFrames: FrameRequestCallback[] = []

  beforeEach(() => {
    animationFrames.length = 0
    mockRenderMath.mockReset()
    mockFinishRenderMath.mockReset()
    mockFinishRenderMath.mockResolvedValue(undefined)
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: jest.fn((callback: FrameRequestCallback) => {
        animationFrames.push(callback)
        return animationFrames.length
      }),
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
  })

  it('renders formulas with the Obsidian math engine', async () => {
    const rendered = {} as HTMLElement
    const replaceChildren = jest.fn()
    const container = {
      replaceChildren,
    } as unknown as HTMLElement
    mockRenderMath.mockReturnValue(rendered)

    renderStreamingMath(container, 'x^2', false)

    expect(mockRenderMath).toHaveBeenCalledWith('x^2', false)
    expect(replaceChildren).toHaveBeenCalledWith(rendered)

    animationFrames[0](0)
    await Promise.resolve()
  })

  it('batches stylesheet flushes from multiple formulas into one frame', async () => {
    mockRenderMath.mockReturnValue({} as HTMLElement)
    const firstContainer = {
      replaceChildren: jest.fn(),
    } as unknown as HTMLElement
    const secondContainer = {
      replaceChildren: jest.fn(),
    } as unknown as HTMLElement

    renderStreamingMath(firstContainer, 'x', false)
    renderStreamingMath(secondContainer, 'y', true)

    expect(animationFrames).toHaveLength(1)
    expect(mockFinishRenderMath).not.toHaveBeenCalled()

    animationFrames[0](0)
    await Promise.resolve()

    expect(mockFinishRenderMath).toHaveBeenCalledTimes(1)
  })

  it('keeps the raw formula when MathJax rejects it', () => {
    const replaceChildren = jest.fn()
    const container = {
      replaceChildren,
    } as unknown as HTMLElement
    mockRenderMath.mockImplementation(() => {
      throw new Error('invalid math')
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    renderStreamingMath(container, '\\invalid', false)

    expect(replaceChildren).not.toHaveBeenCalled()
    expect(animationFrames).toHaveLength(0)
    warn.mockRestore()
  })
})

describe('markUnclosedDisplayMathNodes', () => {
  function createMathTree(source: string): { tree: Root; math: Math } {
    const math = {
      type: 'math',
      value: source.slice(2).replace(/\n?\$\$$/, ''),
      position: {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: source.length + 1, offset: source.length },
      },
    } as Math
    return {
      tree: { type: 'root', children: [math] },
      math,
    }
  }

  it('keeps an unclosed display formula out of MathJax', () => {
    const source = '$$\n\\begin{bmatrix} 1 & 2'
    const { tree, math } = createMathTree(source)

    markUnclosedDisplayMathNodes(tree, source)

    expect(math.data).toEqual({
      hName: 'div',
      hProperties: { className: ['yolo-streaming-math-pending'] },
      hChildren: [{ type: 'text', value: source }],
    })
  })

  it('leaves a closed display formula available to MathJax', () => {
    const source = '$$\nx^2\n$$'
    const { tree, math } = createMathTree(source)

    markUnclosedDisplayMathNodes(tree, source)

    expect(math.data).toBeUndefined()
  })
})

describe('normalizeDisplayMathDelimiters', () => {
  it('puts multiline display delimiters on their own lines', () => {
    expect(
      normalizeDisplayMathDelimiters(
        '$$\\begin{pmatrix}\na & b \\\\\nc & d\n\\end{pmatrix}$$',
      ),
    ).toBe('$$\n\\begin{pmatrix}\na & b \\\\\nc & d\n\\end{pmatrix}\n$$')
  })

  it('normalizes a same-line display formula', () => {
    expect(normalizeDisplayMathDelimiters('Before $$x^2$$ after')).toBe(
      'Before \n$$\nx^2\n$$\n after',
    )
  })

  it('does not change dollar pairs inside code', () => {
    const markdown = [
      '```sh',
      'echo $$',
      '```',
      '',
      'Use `$$x$$` literally.',
    ].join('\n')

    expect(normalizeDisplayMathDelimiters(markdown)).toBe(markdown)
  })

  it('leaves an unclosed display formula unclosed', () => {
    expect(normalizeDisplayMathDelimiters('$$\\frac{1')).toBe('$$\n\\frac{1')
  })
})
