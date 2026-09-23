/* eslint-disable import/no-nodejs-modules -- test reads its golden fixture from disk */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
/* eslint-enable import/no-nodejs-modules */

import {
  MARKDOWN_SEPARATORS,
  RecursiveCharacterTextSplitter,
} from './textSplitter'

type FixtureCase = {
  kind: 'markdown' | 'plain'
  input: string
  options: { chunkSize: number; chunkOverlap?: number }
  chunks?: { content: string; from: number; to: number }[]
  throws?: string
}

// Golden outputs produced by the original @langchain/textsplitters 0.1.0
// implementation (`fromLanguage('markdown', …)` for notes, the plain
// constructor with overlap 0 for PDF pages). Any difference would make
// existing indexes stop matching newly chunked content.
const fixture = JSON.parse(
  readFileSync(join(__dirname, 'textSplitter.fixture.json'), 'utf8'),
) as { inputs: Record<string, string>; cases: FixtureCase[] }

const createSplitter = ({ kind, options }: FixtureCase) =>
  new RecursiveCharacterTextSplitter({
    ...options,
    ...(kind === 'markdown' ? { separators: MARKDOWN_SEPARATORS } : {}),
  })

describe('RecursiveCharacterTextSplitter', () => {
  beforeAll(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterAll(() => {
    jest.restoreAllMocks()
  })

  it.each(
    fixture.cases.map(
      (c) =>
        [`${c.kind} ${c.input} chunkSize=${c.options.chunkSize}`, c] as const,
    ),
  )('matches the original output: %s', (_name, fixtureCase) => {
    if (fixtureCase.throws) {
      expect(() => createSplitter(fixtureCase)).toThrow(fixtureCase.throws)
      return
    }
    const text = fixture.inputs[fixtureCase.input]
    const input = fixtureCase.kind === 'plain' ? text.trim() : text
    const chunks = createSplitter(fixtureCase)
      .splitWithLines(input)
      .map((chunk) => ({
        content: chunk.content,
        from: chunk.lines.from,
        to: chunk.lines.to,
      }))
    expect(chunks).toEqual(fixtureCase.chunks)
  })
})
