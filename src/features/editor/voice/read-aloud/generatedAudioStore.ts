import { App, normalizePath } from 'obsidian'

import type { TtsSynthesisFileResult } from '../../../../core/tts/types'
import { extensionForAudioFormat } from '../../../../core/tts/utils'
import type { TtsConfig } from '../../../../settings/schema/setting.types'

export type GeneratedAudioSaveSession = {
  rootDir: string
  sourceName: string
  sourcePath: string
  totalSegments: number
  startedAt: Date
  configName: string
  segmentPaths: string[]
}

export type SaveGeneratedAudioSegmentInput = {
  session: GeneratedAudioSaveSession
  segmentIndex: number
  audio: TtsSynthesisFileResult
}

export class GeneratedAudioStore {
  constructor(private readonly app: App) {}

  createSession(args: {
    saveDir: string
    sourceName: string
    sourcePath: string
    totalSegments: number
    ttsConfig: TtsConfig
  }): GeneratedAudioSaveSession {
    const root = normalizeVaultRelativeDir(args.saveDir)
    const timestamp = formatTimestamp(
      args.totalSegments > 1 ? new Date() : null,
    )
    const sourceName = sanitizePathPart(stripExtension(args.sourceName))
    const rootDir =
      args.totalSegments > 1
        ? normalizePath(`${root}/${sourceName}-${timestamp}`)
        : root
    return {
      rootDir,
      sourceName,
      sourcePath: args.sourcePath,
      totalSegments: args.totalSegments,
      startedAt: new Date(),
      configName:
        args.ttsConfig.name || args.ttsConfig.model || args.ttsConfig.id,
      segmentPaths: [],
    }
  }

  async saveSegment(input: SaveGeneratedAudioSegmentInput): Promise<string> {
    const { session, segmentIndex, audio } = input
    await ensureVaultDir(this.app, session.rootDir)
    const ext = extensionForAudioFormat(audio.format)
    const timestamp = formatTimestamp(session.startedAt)
    const base =
      session.totalSegments === 1
        ? `${sanitizePathPart(stripExtension(session.sourceName))}-${timestamp}`
        : `${String(segmentIndex + 1).padStart(3, '0')}`
    const path = await reservePath(
      this.app,
      normalizePath(`${session.rootDir}/${base}.${ext}`),
    )
    // Use the Vault API rather than the raw adapter so Obsidian indexes the
    // newly created audio immediately; otherwise editor embeds can point at a
    // path that the file explorer has not learned about yet.
    await this.app.vault.createBinary(path, audio.bytes)
    session.segmentPaths[segmentIndex] = path
    if (session.totalSegments > 1) {
      await this.writeIndex(session)
    }
    return path
  }

  private async writeIndex(session: GeneratedAudioSaveSession): Promise<void> {
    const lines = [
      `# ${session.sourceName}`,
      '',
      `- Source: ${session.sourcePath || session.sourceName}`,
      `- Generated: ${session.startedAt.toLocaleString()}`,
      `- TTS: ${session.configName}`,
      '',
      '## Files',
      '',
      ...session.segmentPaths
        .map((path, index) =>
          path ? `${index + 1}. [[${path}]]` : `${index + 1}. Pending`,
        )
        .filter(Boolean),
      '',
    ]
    const indexPath = normalizePath(`${session.rootDir}/index.md`)
    const existing = this.app.vault.getAbstractFileByPath(indexPath)
    if (existing) {
      await this.app.vault.adapter.write(indexPath, lines.join('\n'))
      return
    }
    await this.app.vault.create(indexPath, lines.join('\n'))
  }
}

export const normalizeVaultRelativeDir = (value: string): string => {
  const normalized = normalizePath(value.trim())
  if (!normalized || normalized === '.' || normalized.startsWith('/')) {
    throw new Error(
      'Generated audio save directory must be a vault-relative path.',
    )
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    throw new Error('Generated audio save directory must be vault-relative.')
  }
  if (normalized.split('/').some((part) => part === '..')) {
    throw new Error('Generated audio save directory cannot contain "..".')
  }
  return normalized
}

const ensureVaultDir = async (app: App, dirPath: string): Promise<void> => {
  const normalized = normalizePath(dirPath)
  const parts = normalized.split('/').filter(Boolean)
  let current = ''
  for (const part of parts) {
    current = current ? `${current}/${part}` : part
    if (await app.vault.adapter.exists(current)) continue
    await app.vault.createFolder(current)
  }
}

const reservePath = async (app: App, desiredPath: string): Promise<string> => {
  if (!(await app.vault.adapter.exists(desiredPath))) return desiredPath
  const dot = desiredPath.lastIndexOf('.')
  const base = dot > 0 ? desiredPath.slice(0, dot) : desiredPath
  const ext = dot > 0 ? desiredPath.slice(dot) : ''
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${i}${ext}`
    if (!(await app.vault.adapter.exists(candidate))) return candidate
  }
  throw new Error(`Could not reserve generated audio path: ${desiredPath}`)
}

const sanitizePathPart = (value: string): string =>
  value.replace(/[\\/:*?"<>|]/g, '-').trim() || 'selection'

const stripExtension = (value: string): string => {
  const idx = value.lastIndexOf('.')
  return idx > 0 ? value.slice(0, idx) : value
}

const formatTimestamp = (date: Date | null): string => {
  const value = date ?? new Date()
  const yyyy = String(value.getFullYear())
  const mm = String(value.getMonth() + 1).padStart(2, '0')
  const dd = String(value.getDate()).padStart(2, '0')
  const hh = String(value.getHours()).padStart(2, '0')
  const min = String(value.getMinutes()).padStart(2, '0')
  const ss = String(value.getSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`
}
