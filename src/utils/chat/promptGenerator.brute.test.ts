/**
 * Minimal tests for PromptGenerator brute mode behavior
 */
import { App, TFile } from 'obsidian'

import { PromptGenerator } from './promptGenerator'

jest.mock('../llm/token', () => ({
  tokenCount: jest.fn(async () => 999999), // force threshold exceed
}))

jest.mock('../obsidian', () => ({
  readMultipleTFiles: jest.fn(async () => ['A', 'B']),
  getNestedFiles: jest.fn((_folder: any) => []),
  readTFileContent: jest.fn(async () => 'X'),
}))

describe('PromptGenerator brute mode', () => {
  it('forces non-RAG and concatenates all mentioned files', async () => {
    const fakeApp = { vault: {} } as unknown as App
    const settings: any = {
      ragOptions: { thresholdTokens: 10 },
      chatOptions: { includeCurrentFileContent: false, maxContextMessages: 0 },
      assistants: [],
    }

    const gen = new PromptGenerator(async () => ({}) as any, fakeApp, settings)

    const file1 = { path: 'a.md' } as unknown as TFile
    const file2 = { path: 'b.md' } as unknown as TFile

    const message: any = {
      role: 'user',
      content: {
        root: { children: [{ type: 'paragraph', children: [{ text: 'Q' }] }] },
      },
      mentionables: [
        { type: 'file', file: file1 },
        { type: 'file', file: file2 },
      ],
    }
    const { shouldUseRAG, promptContent } = await gen.compileUserMessagePrompt({
      message,
      chatMode: 'brute',
    })

    expect(shouldUseRAG).toBe(false)
    const textPart = (promptContent as any[]).find((p) => p.type === 'text')
    expect(textPart.text).toContain('```a.md')
    expect(textPart.text).toContain('```b.md')
  })
})
