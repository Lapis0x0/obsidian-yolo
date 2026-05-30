import { App, FileSystemAdapter, TFile } from 'obsidian'

export type AudioFileSource = {
  kind: 'blob' | 'vault'
  name: string
  size: number
  type: string
  lastModified: number
  getFile(): Promise<File>
  readSlice(start: number, end: number): Promise<Blob>
  createObjectUrl(): Promise<{ url: string; revoke: () => void } | null>
}

const VAULT_MEMORY_FILE_LIMIT_BYTES = 32 * 1024 * 1024

export function createBlobAudioFileSource(file: File): AudioFileSource {
  return {
    kind: 'blob',
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    async getFile() {
      return file
    },
    async readSlice(start, end) {
      return file.slice(start, end, file.type)
    },
    async createObjectUrl() {
      const url = URL.createObjectURL(file)
      return {
        url,
        revoke: () => URL.revokeObjectURL(url),
      }
    },
  }
}

export function createVaultAudioFileSource(input: {
  app: App
  file: TFile
  mimeType: string
  materializeLimitMessage: string
}): AudioFileSource {
  const { app, file, mimeType, materializeLimitMessage } = input
  return {
    kind: 'vault',
    name: file.name,
    size: file.stat.size,
    type: mimeType,
    lastModified: file.stat.mtime,
    async getFile() {
      if (file.stat.size > VAULT_MEMORY_FILE_LIMIT_BYTES) {
        throw new Error(materializeLimitMessage)
      }
      const data = await app.vault.readBinary(file)
      return new File([data], file.name, {
        type: mimeType,
        lastModified: file.stat.mtime,
      })
    },
    async readSlice(start, end) {
      const from = clampByteOffset(start, file.stat.size)
      const to = clampByteOffset(end, file.stat.size)
      if (to <= from) return new Blob([], { type: mimeType })

      const adapter = app.vault.adapter
      if (adapter instanceof FileSystemAdapter) {
        return readVaultFileSliceFromDisk({
          path: adapter.getFullPath(file.path),
          start: from,
          end: to,
          mimeType,
        })
      }

      if (file.stat.size > VAULT_MEMORY_FILE_LIMIT_BYTES) {
        throw new Error(materializeLimitMessage)
      }
      const data = await app.vault.readBinary(file)
      return new Blob([data.slice(from, to)], { type: mimeType })
    },
    async createObjectUrl() {
      return {
        url: app.vault.getResourcePath(file),
        revoke: () => undefined,
      }
    },
  }
}

function clampByteOffset(value: number, size: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(size, Math.max(0, Math.floor(value)))
}

async function readVaultFileSliceFromDisk(input: {
  path: string
  start: number
  end: number
  mimeType: string
}): Promise<Blob> {
  const length = input.end - input.start
  const buffer = new Uint8Array(length)
  // eslint-disable-next-line import/no-nodejs-modules -- desktop vault files need range reads without loading the full audio into memory.
  const { open } = await import('node:fs/promises')
  const handle = await open(input.path, 'r')
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, input.start)
    return new Blob([buffer.subarray(0, bytesRead)], {
      type: input.mimeType,
    })
  } finally {
    await handle.close()
  }
}
