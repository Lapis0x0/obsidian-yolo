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

  // 渲染容器归属哪个窗口，补排版的那一帧就必须由哪个窗口调度：popout 是独立
  // BrowserWindow，主窗口被最小化时它的 rAF 会停摆。因此容器在测试里也必须
  // 带上 ownerDocument/defaultView，而不是依赖全局 rAF。
  const createOwnerWindow = () => ({
    requestAnimationFrame: jest.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback)
      return animationFrames.length
    }),
  })
  const ownerWindow = createOwnerWindow()
  const createContainer = (
    replaceChildren: jest.Mock,
    win: { requestAnimationFrame: jest.Mock } = ownerWindow,
  ) =>
    ({
      replaceChildren,
      ownerDocument: { defaultView: win },
    }) as unknown as HTMLElement

  beforeEach(() => {
    animationFrames.length = 0
    ownerWindow.requestAnimationFrame.mockClear()
    mockRenderMath.mockReset()
    mockFinishRenderMath.mockReset()
    mockFinishRenderMath.mockResolvedValue(undefined)
  })

  it('renders formulas with the Obsidian math engine', async () => {
    const rendered = {} as HTMLElement
    const replaceChildren = jest.fn()
    const container = createContainer(replaceChildren)
    mockRenderMath.mockReturnValue(rendered)

    renderStreamingMath(container, 'x^2', false)

    expect(mockRenderMath).toHaveBeenCalledWith('x^2', false)
    expect(replaceChildren).toHaveBeenCalledWith(rendered)

    animationFrames[0](0)
    await Promise.resolve()
  })

  it('schedules the flush frame on the container owner window', async () => {
    mockRenderMath.mockReturnValue({} as HTMLElement)
    const popoutWindow = createOwnerWindow()

    renderStreamingMath(createContainer(jest.fn(), popoutWindow), 'x', false)

    expect(popoutWindow.requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(ownerWindow.requestAnimationFrame).not.toHaveBeenCalled()

    // 批处理闸门是模块级单例：这一帧不放行，后续用例就排不进新的帧。
    animationFrames[0](0)
    await Promise.resolve()
  })

  it('batches stylesheet flushes from multiple formulas into one frame', async () => {
    mockRenderMath.mockReturnValue({} as HTMLElement)

    renderStreamingMath(createContainer(jest.fn()), 'x', false)
    renderStreamingMath(createContainer(jest.fn()), 'y', true)

    expect(animationFrames).toHaveLength(1)
    expect(mockFinishRenderMath).not.toHaveBeenCalled()

    animationFrames[0](0)
    await Promise.resolve()

    expect(mockFinishRenderMath).toHaveBeenCalledTimes(1)
  })

  it('keeps the raw formula when MathJax rejects it', () => {
    const replaceChildren = jest.fn()
    const container = createContainer(replaceChildren)
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
