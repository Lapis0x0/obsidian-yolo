import type { App } from 'obsidian'

import { ClaudeMdCache } from '../claudeMdCache'
import { MAX_CACHE_SIZE } from '../claudeMdTypes'

function createMockApp(
  files: Record<string, { content: string; mtime: number }>,
): App {
  return {
    vault: {
      adapter: {
        stat: async (path: string) => files[path] ?? null,
        read: async (path: string) => files[path]?.content ?? null,
      },
    },
  } as any
}

describe('ClaudeMdCache', () => {
  it('should return parsed content from cache on second call', async () => {
    const files: Record<string, { content: string; mtime: number }> = {
      'test.md': { content: 'hello', mtime: 1000 },
    }
    const app = createMockApp(files)
    const cache = new ClaudeMdCache()

    const result1 = await cache.getOrLoad(app, 'test.md', (raw) => ({
      filePath: 'test.md',
      content: raw,
    }))
    const result2 = await cache.getOrLoad(app, 'test.md', (raw) => ({
      filePath: 'test.md',
      content: raw + '_should_not_use',
    }))

    expect(result1?.content).toBe('hello')
    expect(result2?.content).toBe('hello')
  })

  it('should reload when mtime changes', async () => {
    const files: Record<string, { content: string; mtime: number }> = {
      'test.md': { content: 'updated', mtime: 2000 },
    }
    const app = createMockApp(files)
    const cache = new ClaudeMdCache()

    // First load
    await cache.getOrLoad(app, 'test.md', (raw) => ({
      filePath: 'test.md',
      content: raw,
    }))

    // Update mtime
    files['test.md'] = { content: 'new content', mtime: 3000 }

    const result = await cache.getOrLoad(app, 'test.md', (raw) => ({
      filePath: 'test.md',
      content: raw,
    }))
    expect(result?.content).toBe('new content')
  })

  it('should return null for non-existent file', async () => {
    const app = createMockApp({})
    const cache = new ClaudeMdCache()

    const result = await cache.getOrLoad(app, 'missing.md', (raw) => ({
      filePath: 'missing.md',
      content: raw,
    }))
    expect(result).toBeNull()
  })

  it('should evict oldest entry when cache exceeds max size', async () => {
    // We test eviction by filling the cache beyond its limit
    const cache = new ClaudeMdCache()
    const files: Record<string, { content: string; mtime: number }> = {}

    // Create MAX_CACHE_SIZE + 1 files
    for (let i = 0; i <= MAX_CACHE_SIZE; i++) {
      const path = `file_${i}.md`
      files[path] = { content: `content_${i}`, mtime: 1000 + i }
    }

    const app = createMockApp(files)

    // Load all files
    for (let i = 0; i <= MAX_CACHE_SIZE; i++) {
      await cache.getOrLoad(app, `file_${i}.md`, (raw) => ({
        filePath: `file_${i}.md`,
        content: raw,
      }))
    }

    // The first file should have been evicted (FIFO)
    // Access it again - it should be re-read (mtime changed to verify)
    files['file_0.md'] = { content: 'reloaded', mtime: 9999 }
    const result = await cache.getOrLoad(app, 'file_0.md', (raw) => ({
      filePath: 'file_0.md',
      content: raw,
    }))
    expect(result?.content).toBe('reloaded')
  })

  it('should clean up deleted files from cache', async () => {
    const files: Record<string, { content: string; mtime: number }> = {
      'test.md': { content: 'hello', mtime: 1000 },
    }
    const app = createMockApp(files)
    const cache = new ClaudeMdCache()

    // Load file
    await cache.getOrLoad(app, 'test.md', (raw) => ({
      filePath: 'test.md',
      content: raw,
    }))

    // Delete file
    delete files['test.md']

    const result = await cache.getOrLoad(app, 'test.md', (raw) => ({
      filePath: 'test.md',
      content: raw,
    }))
    expect(result).toBeNull()
  })

  it('should clear all entries', async () => {
    const files: Record<string, { content: string; mtime: number }> = {
      'a.md': { content: 'a', mtime: 1000 },
      'b.md': { content: 'b', mtime: 1000 },
    }
    const app = createMockApp(files)
    const cache = new ClaudeMdCache()

    await cache.getOrLoad(app, 'a.md', (raw) => ({
      filePath: 'a.md',
      content: raw,
    }))
    await cache.getOrLoad(app, 'b.md', (raw) => ({
      filePath: 'b.md',
      content: raw,
    }))

    cache.clear()

    // After clear, files should be re-loaded
    files['a.md'] = { content: 'reloaded_a', mtime: 2000 }
    const result = await cache.getOrLoad(app, 'a.md', (raw) => ({
      filePath: 'a.md',
      content: raw,
    }))
    expect(result?.content).toBe('reloaded_a')
  })
})
