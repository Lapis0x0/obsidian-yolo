// src/core/claude-md/claudeMdCache.ts
import { App } from 'obsidian'

import { CacheEntry, MAX_CACHE_SIZE, ParsedMemoryFile } from './claudeMdTypes'

export class ClaudeMdCache {
  private cache = new Map<string, CacheEntry>()

  async getOrLoad(
    app: App,
    filePath: string,
    loader: (rawContent: string) => ParsedMemoryFile,
  ): Promise<ParsedMemoryFile | null> {
    try {
      const stat = await app.vault.adapter.stat(filePath)
      if (!stat) {
        this.cache.delete(filePath)
        return null
      }

      const cached = this.cache.get(filePath)
      if (cached && cached.mtime === stat.mtime) {
        return cached.parsed
      }

      const rawContent = await app.vault.adapter.read(filePath)
      const parsed = loader(rawContent)

      if (this.cache.size >= MAX_CACHE_SIZE) {
        const firstKey = this.cache.keys().next().value
        if (firstKey !== undefined) {
          this.cache.delete(firstKey)
        }
      }

      this.cache.set(filePath, {
        rawContent,
        mtime: stat.mtime,
        parsed,
      })

      return parsed
    } catch {
      console.warn('[claude-md] Failed to load cache:', filePath)
      return null
    }
  }

  clear(): void {
    this.cache.clear()
  }
}
