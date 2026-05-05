import { App } from 'obsidian'

import {
  clearAllExternalAgentProgressStores,
  getExternalAgentProgressStorageBytes,
  loadExternalAgentProgress,
  saveExternalAgentProgress,
} from './externalAgentProgressStore'

class MockAdapter {
  readonly files = new Map<string, string>()
  private readonly folders = new Set<string>()

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path)
  }

  async mkdir(path: string): Promise<void> {
    const segments = path.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      this.folders.add(current)
    }
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path)
    if (value === undefined) throw new Error(`Missing file: ${path}`)
    return value
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content)
    await this.mkdir(path.split('/').slice(0, -1).join('/'))
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`
    return {
      files: [...this.files.keys()].filter((fp) => fp.startsWith(prefix)),
      folders: [...this.folders].filter(
        (fp) => fp !== path && fp.startsWith(prefix),
      ),
    }
  }

  async stat(
    path: string,
  ): Promise<{ type: 'file' | 'folder'; size: number } | null> {
    if (this.files.has(path)) {
      return { type: 'file', size: this.files.get(path)!.length }
    }
    if (this.folders.has(path)) {
      return { type: 'folder', size: 0 }
    }
    return null
  }
}

const createApp = () => {
  const adapter = new MockAdapter()
  return {
    app: { vault: { adapter } } as unknown as App,
    adapter,
  }
}

const MAX_PROGRESS_BYTES = 256 * 1024

describe('externalAgentProgressStore', () => {
  it('save + load round-trip', async () => {
    const { app } = createApp()
    await saveExternalAgentProgress({
      app,
      conversationId: 'conv-1',
      toolCallId: 'tool-1',
      progressText: 'hello world',
    })

    const result = await loadExternalAgentProgress({
      app,
      toolCallId: 'tool-1',
    })
    expect(result).not.toBeNull()
    expect(result!.progressText).toBe('hello world')
    expect(result!.conversationId).toBe('conv-1')
    expect(typeof result!.savedAt).toBe('number')
    expect(result!.truncated).toBeUndefined()
  })

  it('truncates oversized input and keeps tail; stored byte length ≤ MAX', async () => {
    const { app } = createApp()
    // Create text slightly larger than 256KB
    const bigText = 'A'.repeat(MAX_PROGRESS_BYTES + 100)

    await saveExternalAgentProgress({
      app,
      conversationId: 'conv-1',
      toolCallId: 'tool-trunc',
      progressText: bigText,
    })

    const result = await loadExternalAgentProgress({
      app,
      toolCallId: 'tool-trunc',
    })
    expect(result).not.toBeNull()
    const storedBytes = Buffer.byteLength(result!.progressText, 'utf8')
    expect(storedBytes).toBeLessThanOrEqual(MAX_PROGRESS_BYTES)
    expect(result!.truncated).toBeDefined()
    expect(result!.truncated!.omittedBytes).toBeGreaterThan(0)
    expect(result!.truncated!.totalBytes).toBeGreaterThan(MAX_PROGRESS_BYTES)
  })

  it('preserves tail content after truncation', async () => {
    const { app } = createApp()
    const padding = 'X'.repeat(MAX_PROGRESS_BYTES)
    const tail = 'TAIL_MARKER_END'
    const bigText = padding + tail

    await saveExternalAgentProgress({
      app,
      conversationId: 'conv-1',
      toolCallId: 'tool-tail',
      progressText: bigText,
    })

    const result = await loadExternalAgentProgress({
      app,
      toolCallId: 'tool-tail',
    })
    expect(result!.progressText).toContain(tail)
  })

  it('truncation metadata totalBytes and omittedBytes are correct', async () => {
    const { app } = createApp()
    const bigText = 'B'.repeat(MAX_PROGRESS_BYTES + 1000)
    const totalBytes = Buffer.byteLength(bigText, 'utf8')

    await saveExternalAgentProgress({
      app,
      conversationId: 'conv-1',
      toolCallId: 'tool-meta',
      progressText: bigText,
    })

    const result = await loadExternalAgentProgress({
      app,
      toolCallId: 'tool-meta',
    })
    expect(result!.truncated!.totalBytes).toBe(totalBytes)
    const keptBytes = Buffer.byteLength(result!.progressText, 'utf8')
    expect(result!.truncated!.omittedBytes).toBe(
      totalBytes -
        (keptBytes -
          Buffer.byteLength('... [head truncated, kept tail] ...\n', 'utf8')),
    )
  })

  it('toolCallId with special characters is filename-safe and round-trips', async () => {
    const { app, adapter } = createApp()
    const specialId = 'tool/call:with spaces and/slashes'

    await saveExternalAgentProgress({
      app,
      conversationId: 'conv-special',
      toolCallId: specialId,
      progressText: 'special chars test',
    })

    // Verify no file path contains the raw special chars (path traversal guard)
    for (const filePath of adapter.files.keys()) {
      expect(filePath).not.toContain('//')
      // raw slash from toolCallId should not appear in the filename segment
      const fileName = filePath.split('/').pop()!
      expect(fileName).not.toContain(' ')
    }

    const result = await loadExternalAgentProgress({
      app,
      toolCallId: specialId,
    })
    expect(result).not.toBeNull()
    expect(result!.progressText).toBe('special chars test')
    expect(result!.conversationId).toBe('conv-special')
  })

  it('clearAll removes all files; subsequent load returns null', async () => {
    const { app } = createApp()

    await saveExternalAgentProgress({
      app,
      conversationId: 'conv-1',
      toolCallId: 'tool-a',
      progressText: 'log a',
    })
    await saveExternalAgentProgress({
      app,
      conversationId: 'conv-2',
      toolCallId: 'tool-b',
      progressText: 'log b',
    })

    await clearAllExternalAgentProgressStores(app)

    expect(
      await loadExternalAgentProgress({ app, toolCallId: 'tool-a' }),
    ).toBeNull()
    expect(
      await loadExternalAgentProgress({ app, toolCallId: 'tool-b' }),
    ).toBeNull()
  })

  it('getStorageBytes returns 0 for empty directory', async () => {
    const { app } = createApp()
    const bytes = await getExternalAgentProgressStorageBytes(app)
    expect(bytes).toBe(0)
  })

  it('getStorageBytes returns positive number after write', async () => {
    const { app } = createApp()
    await saveExternalAgentProgress({
      app,
      conversationId: 'conv-1',
      toolCallId: 'tool-size',
      progressText: 'some progress text',
    })

    const bytes = await getExternalAgentProgressStorageBytes(app)
    expect(bytes).toBeGreaterThan(0)
  })

  it('load returns null for non-existent toolCallId', async () => {
    const { app } = createApp()
    const result = await loadExternalAgentProgress({
      app,
      toolCallId: 'nonexistent',
    })
    expect(result).toBeNull()
  })
})
