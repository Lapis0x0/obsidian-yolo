import { App, normalizePath } from 'obsidian'

import { ensureJsonDbRootDir } from '../../../core/paths/yoloManagedData'
import { CHAT_DIR } from '../constants'

export const EXTERNAL_AGENT_PROGRESS_DIR = 'external_agent_progress'

// 256KB byte limit for stored progress text
const MAX_PROGRESS_BYTES = 256 * 1024
const TRUNCATION_MARKER = '... [head truncated, kept tail] ...\n'

type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

export type StoredProgress = {
  conversationId: string
  progressText: string
  savedAt: number
  truncated?: { totalBytes: number; omittedBytes: number }
}

// base64url encoding avoids path traversal and cross-platform filename issues
function encodeFilename(toolCallId: string): string {
  return Buffer.from(toolCallId, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

async function getDirPath(
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<string> {
  const rootDir = await ensureJsonDbRootDir(app, settings)
  return normalizePath(`${rootDir}/${CHAT_DIR}/${EXTERNAL_AGENT_PROGRESS_DIR}`)
}

async function getFilePath(
  app: App,
  toolCallId: string,
  settings?: YoloSettingsLike | null,
): Promise<string> {
  const dir = await getDirPath(app, settings)
  return normalizePath(`${dir}/${encodeFilename(toolCallId)}.json`)
}

/**
 * Truncate text to MAX_PROGRESS_BYTES by utf-8 byte length, keeping the tail.
 * Finds a valid utf-8 character boundary to avoid replacement chars.
 */
function truncateToTail(text: string): {
  truncated: string
  totalBytes: number
  omittedBytes: number
} {
  const totalBytes = Buffer.byteLength(text, 'utf8')
  if (totalBytes <= MAX_PROGRESS_BYTES) {
    return { truncated: text, totalBytes, omittedBytes: 0 }
  }

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8')
  const keepBytes = MAX_PROGRESS_BYTES - markerBytes

  const buf = Buffer.from(text, 'utf8')
  // tail starts at: totalBytes - keepBytes from the end
  let tailStart = buf.length - keepBytes
  // Walk forward past any utf-8 continuation bytes (0x80–0xBF) to find a
  // valid character boundary at the front of the tail
  while (tailStart < buf.length && (buf[tailStart] & 0xc0) === 0x80) {
    tailStart++
  }

  const tailText = buf.subarray(tailStart).toString('utf8')
  return {
    truncated: TRUNCATION_MARKER + tailText,
    totalBytes,
    omittedBytes: totalBytes - Buffer.byteLength(tailText, 'utf8'),
  }
}

export const saveExternalAgentProgress = async ({
  app,
  settings,
  conversationId,
  toolCallId,
  progressText,
}: {
  app: App
  settings?: YoloSettingsLike | null
  conversationId: string
  toolCallId: string
  progressText: string
}): Promise<void> => {
  const dir = await getDirPath(app, settings)
  if (!(await app.vault.adapter.exists(dir))) {
    await app.vault.adapter.mkdir(dir)
  }

  const {
    truncated: finalText,
    totalBytes,
    omittedBytes,
  } = truncateToTail(progressText)

  const entry: StoredProgress = {
    conversationId,
    progressText: finalText,
    savedAt: Date.now(),
    ...(omittedBytes > 0 ? { truncated: { totalBytes, omittedBytes } } : {}),
  }

  const filePath = await getFilePath(app, toolCallId, settings)
  await app.vault.adapter.write(filePath, JSON.stringify(entry))
}

export const loadExternalAgentProgress = async ({
  app,
  settings,
  toolCallId,
}: {
  app: App
  settings?: YoloSettingsLike | null
  toolCallId: string
}): Promise<StoredProgress | null> => {
  const filePath = await getFilePath(app, toolCallId, settings)
  if (!(await app.vault.adapter.exists(filePath))) {
    return null
  }

  try {
    const content = await app.vault.adapter.read(filePath)
    const parsed = JSON.parse(content) as StoredProgress
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.progressText !== 'string'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export const clearAllExternalAgentProgressStores = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  const dir = await getDirPath(app, settings)
  if (!(await app.vault.adapter.exists(dir))) {
    return
  }

  const listing = await app.vault.adapter.list(dir)
  for (const filePath of listing.files) {
    await app.vault.adapter.remove(filePath)
  }
}

export const getExternalAgentProgressStorageBytes = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<number> => {
  const dir = await getDirPath(app, settings)
  if (!(await app.vault.adapter.exists(dir))) {
    return 0
  }

  const listing = await app.vault.adapter.list(dir)
  let total = 0
  for (const filePath of listing.files) {
    const stat = await app.vault.adapter.stat(filePath)
    total += stat?.size ?? 0
  }
  return total
}
