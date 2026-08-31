import type { Root } from 'mdast'
import type { Math } from 'mdast-util-math'
import { finishRenderMath, renderMath } from 'obsidian'
import type { Plugin } from 'unified'

import { getNodeWindow } from '../../utils/dom/window-context'

type MarkdownNode = {
  type: string
  children?: MarkdownNode[]
  position?: {
    start: { offset?: number }
    end: { offset?: number }
  }
}

function markUnclosedDisplayMath(node: Math, source: string): void {
  const startOffset = node.position?.start.offset
  const endOffset = node.position?.end.offset
  if (startOffset === undefined || endOffset === undefined) {
    return
  }

  const rawSource = source.slice(startOffset, endOffset)
  if (rawSource.slice(2).trimEnd().endsWith('$$')) {
    return
  }

  node.data = {
    hName: 'div',
    hProperties: { className: ['yolo-streaming-math-pending'] },
    hChildren: [{ type: 'text', value: rawSource }],
  }
}

export function markUnclosedDisplayMathNodes(tree: Root, source: string): void {
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'math') {
      markUnclosedDisplayMath(node as Math, source)
      return
    }

    node.children?.forEach(visit)
  }

  visit(tree as MarkdownNode)
}

export const preserveUnclosedMathSource: Plugin<[], Root> = () => {
  return (tree, file) => {
    markUnclosedDisplayMathNodes(tree, String(file.value))
  }
}

function isEscaped(source: string, index: number): boolean {
  let backslashCount = 0
  for (
    let cursor = index - 1;
    cursor >= 0 && source[cursor] === '\\';
    cursor--
  ) {
    backslashCount++
  }
  return backslashCount % 2 === 1
}

export function normalizeDisplayMathDelimiters(markdown: string): string {
  // This runs on every streamed frame over the whole document. Without a `$$`
  // there is nothing to normalize and the scan would rebuild the entire string
  // for an identical result.
  if (!markdown.includes('$$')) {
    return markdown
  }

  let displayMathOpen = false
  let fence: { marker: string; length: number } | null = null

  return markdown
    .split('\n')
    .map((line) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
      if (fence) {
        if (
          fenceMatch &&
          fenceMatch[1][0] === fence.marker &&
          fenceMatch[1].length >= fence.length &&
          line.slice(fenceMatch[0].length).trim().length === 0
        ) {
          fence = null
        }
        return line
      }

      if (fenceMatch && !displayMathOpen) {
        fence = {
          marker: fenceMatch[1][0],
          length: fenceMatch[1].length,
        }
        return line
      }

      let normalized = ''
      let inlineCodeTicks = 0
      for (let index = 0; index < line.length; ) {
        if (!displayMathOpen && line[index] === '`') {
          let runLength = 1
          while (line[index + runLength] === '`') {
            runLength++
          }
          if (inlineCodeTicks === 0) {
            inlineCodeTicks = runLength
          } else if (inlineCodeTicks === runLength) {
            inlineCodeTicks = 0
          }
          normalized += line.slice(index, index + runLength)
          index += runLength
          continue
        }

        if (
          inlineCodeTicks === 0 &&
          line.startsWith('$$', index) &&
          !isEscaped(line, index)
        ) {
          if (displayMathOpen) {
            if (normalized.length > 0 && !normalized.endsWith('\n')) {
              normalized += '\n'
            }
            normalized += '$$'
            displayMathOpen = false
            if (index + 2 < line.length) {
              normalized += '\n'
            }
          } else {
            if (normalized.length > 0 && !normalized.endsWith('\n')) {
              normalized += '\n'
            }
            normalized += '$$'
            displayMathOpen = true
            if (index + 2 < line.length) {
              normalized += '\n'
            }
          }
          index += 2
          continue
        }

        normalized += line[index]
        index++
      }

      return normalized
    })
    .join('\n')
}

let finishScheduled = false
let finishInProgress = false
let finishRequested = false
// 最近一次请求补排版的窗口。`finishRenderMath()` 是进程级的，所以这个批处理
// 闸门也是模块级单例；但驱动它的那一帧必须来自实际渲染发生的窗口——popout 是
// 独立 BrowserWindow，主窗口被最小化时它的 rAF 会停摆，公式就永远补不上第二遍
// 排版。
let pendingFinishWindow: (Window & typeof globalThis) | null = null

async function flushRenderedMath(): Promise<void> {
  finishScheduled = false
  finishRequested = false
  finishInProgress = true

  try {
    await finishRenderMath()
  } catch (error) {
    console.warn('[YOLO] Failed to finish streaming math render', error)
  } finally {
    finishInProgress = false
    if (finishRequested && pendingFinishWindow) {
      scheduleFinishRenderMath(pendingFinishWindow)
    }
  }
}

function scheduleFinishRenderMath(
  ownerWindow: Window & typeof globalThis,
): void {
  finishRequested = true
  pendingFinishWindow = ownerWindow
  if (finishScheduled || finishInProgress) {
    return
  }

  finishScheduled = true
  ownerWindow.requestAnimationFrame(() => {
    void flushRenderedMath()
  })
}

export function renderStreamingMath(
  container: HTMLElement,
  source: string,
  display: boolean,
): void {
  try {
    const renderedMath = renderMath(source, display)
    container.replaceChildren(renderedMath)
    scheduleFinishRenderMath(getNodeWindow(container))
  } catch (error) {
    console.warn('[YOLO] Failed to render streaming math', error)
  }
}
