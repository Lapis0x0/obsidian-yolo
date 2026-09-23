/**
 * Recursive character text splitter used to chunk notes and PDF pages for the
 * vector index.
 *
 * Ported from `RecursiveCharacterTextSplitter` in @langchain/textsplitters
 * 0.1.0 (https://github.com/langchain-ai/langchainjs), keeping only the paths
 * the index uses: the default `keepSeparator: true` behavior, `text.length` as
 * the length function, the markdown separator table, and line-range tracking
 * from `createDocuments`. Output must stay byte-identical to the original —
 * existing indexes are keyed by chunk content — which
 * `textSplitter.fixture.json` (generated from the original) pins down.
 *
 * The MIT License
 *
 * Copyright (c) 2023 LangChain
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

export const DEFAULT_SEPARATORS = ['\n\n', '\n', ' ', '']

export const MARKDOWN_SEPARATORS = [
  // Markdown headings, starting with level 2
  '\n## ',
  '\n### ',
  '\n#### ',
  '\n##### ',
  '\n###### ',
  // End of code block
  '```\n\n',
  // Horizontal lines
  '\n\n***\n\n',
  '\n\n---\n\n',
  '\n\n___\n\n',
  '\n\n',
  '\n',
  ' ',
  '',
]

export type TextChunk = {
  content: string
  /** 1-based line range of the chunk within the source text. */
  lines: { from: number; to: number }
}

type TextSplitterOptions = {
  chunkSize?: number
  chunkOverlap?: number
  separators?: string[]
}

const countNewLines = (text: string, start?: number, end?: number): number =>
  (text.slice(start, end).match(/\n/g) || []).length

export class RecursiveCharacterTextSplitter {
  private readonly chunkSize: number
  private readonly chunkOverlap: number
  private readonly separators: string[]

  constructor(options: TextSplitterOptions = {}) {
    this.chunkSize = options.chunkSize ?? 1000
    this.chunkOverlap = options.chunkOverlap ?? 200
    this.separators = options.separators ?? DEFAULT_SEPARATORS
    if (this.chunkOverlap >= this.chunkSize) {
      throw new Error('Cannot have chunkOverlap >= chunkSize')
    }
  }

  splitText(text: string): string[] {
    return this.splitRecursive(text, this.separators)
  }

  /** Splits `text` and records which source lines each chunk spans. */
  splitWithLines(text: string): TextChunk[] {
    const chunks: TextChunk[] = []
    let lineCounterIndex = 1
    let prevChunk: string | null = null
    let indexPrevChunk = -1
    for (const chunk of this.splitText(text)) {
      // Count the newlines the splitting removed between chunks.
      const indexChunk = text.indexOf(chunk, indexPrevChunk + 1)
      if (prevChunk === null) {
        lineCounterIndex += countNewLines(text, 0, indexChunk)
      } else {
        const indexEndPrevChunk = indexPrevChunk + prevChunk.length
        if (indexEndPrevChunk < indexChunk) {
          lineCounterIndex += countNewLines(text, indexEndPrevChunk, indexChunk)
        } else if (indexEndPrevChunk > indexChunk) {
          lineCounterIndex -= countNewLines(text, indexChunk, indexEndPrevChunk)
        }
      }
      const newLinesCount = countNewLines(chunk)
      chunks.push({
        content: chunk,
        lines: {
          from: lineCounterIndex,
          to: lineCounterIndex + newLinesCount,
        },
      })
      lineCounterIndex += newLinesCount
      prevChunk = chunk
      indexPrevChunk = indexChunk
    }
    return chunks
  }

  private splitRecursive(text: string, separators: string[]): string[] {
    const finalChunks: string[] = []

    let separator = separators[separators.length - 1]
    let newSeparators: string[] | undefined
    for (let i = 0; i < separators.length; i += 1) {
      const s = separators[i]
      if (s === '') {
        separator = s
        break
      }
      if (text.includes(s)) {
        separator = s
        newSeparators = separators.slice(i + 1)
        break
      }
    }

    const splits = splitKeepingSeparator(text, separator)

    let goodSplits: string[] = []
    for (const s of splits) {
      if (s.length < this.chunkSize) {
        goodSplits.push(s)
      } else {
        if (goodSplits.length) {
          finalChunks.push(...this.mergeSplits(goodSplits))
          goodSplits = []
        }
        if (!newSeparators) {
          finalChunks.push(s)
        } else {
          finalChunks.push(...this.splitRecursive(s, newSeparators))
        }
      }
    }
    if (goodSplits.length) {
      finalChunks.push(...this.mergeSplits(goodSplits))
    }
    return finalChunks
  }

  // Separators stay attached to the following split, so pieces are joined
  // back with no extra separator.
  private mergeSplits(splits: string[]): string[] {
    const docs: string[] = []
    const currentDoc: string[] = []
    let total = 0
    for (const d of splits) {
      const len = d.length
      if (total + len > this.chunkSize) {
        if (total > this.chunkSize) {
          console.warn(
            `Created a chunk of size ${total}, which is longer than the specified ${this.chunkSize}`,
          )
        }
        if (currentDoc.length > 0) {
          const doc = joinDocs(currentDoc)
          if (doc !== null) {
            docs.push(doc)
          }
          // Keep popping while the retained overlap is too large, or while
          // the next split still would not fit.
          while (
            total > this.chunkOverlap ||
            (total + len > this.chunkSize && total > 0)
          ) {
            total -= currentDoc[0].length
            currentDoc.shift()
          }
        }
      }
      currentDoc.push(d)
      total += len
    }
    const doc = joinDocs(currentDoc)
    if (doc !== null) {
      docs.push(doc)
    }
    return docs
  }
}

const splitKeepingSeparator = (text: string, separator: string): string[] => {
  let splits: string[]
  if (separator) {
    const escaped = separator.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&')
    splits = text.split(new RegExp(`(?=${escaped})`))
  } else {
    splits = text.split('')
  }
  return splits.filter((s) => s !== '')
}

const joinDocs = (docs: string[]): string | null => {
  const text = docs.join('').trim()
  return text === '' ? null : text
}
