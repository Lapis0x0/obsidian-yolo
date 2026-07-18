/* eslint-disable import/no-extraneous-dependencies -- Parser dependencies are supplied by the first-party module build workspace. */
import { decompress } from 'fzstd'
import * as JSZipModule from 'jszip'

import { decodeModernMediaMap, decodePackageVersion } from './protobuf'
import { type AnkiParseLimits, DEFAULT_ANKI_LIMITS } from './types'

const JSZip =
  (JSZipModule as unknown as { default?: typeof import('jszip') }).default ??
  JSZipModule

export type AnkiArchive = {
  format: 'legacy' | 'modern'
  collection: Uint8Array
  media: Record<string, string>
  mediaFiles: Map<string, Uint8Array>
  packageVersion: number | null
}

const isSafeEntry = (name: string): boolean =>
  !!name &&
  !name.startsWith('/') &&
  !name.includes('\\') &&
  !name.split('/').includes('..') &&
  !name.includes('\0')

const isZstd = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x28 &&
  bytes[1] === 0xb5 &&
  bytes[2] === 0x2f &&
  bytes[3] === 0xfd

export const readAnkiArchive = async (
  input: Uint8Array,
  overrides: Partial<AnkiParseLimits> = {},
): Promise<AnkiArchive> => {
  const limits = { ...DEFAULT_ANKI_LIMITS, ...overrides }
  if (input.byteLength > limits.packageBytes)
    throw new Error('APKG exceeds package size limit')
  const zip = await JSZip.loadAsync(input, {
    checkCRC32: true,
    createFolders: false,
  })
  const entries = Object.values(zip.files).filter((entry) => !entry.dir)
  if (entries.length > limits.entryCount)
    throw new Error('APKG has too many entries')
  let declaredTotal = 0
  for (const entry of entries) {
    if (!isSafeEntry(entry.name))
      throw new Error(`Unsafe APKG entry path: ${entry.name}`)
    const sizes = entry as unknown as {
      _data?: { compressedSize?: number; uncompressedSize?: number }
    }
    const compressed = sizes._data?.compressedSize ?? 0
    const uncompressed = sizes._data?.uncompressedSize ?? 0
    if (
      compressed > limits.entryCompressedBytes ||
      uncompressed > limits.entryUncompressedBytes
    )
      throw new Error(`APKG entry exceeds size limit: ${entry.name}`)
    declaredTotal += uncompressed
  }
  if (declaredTotal > limits.totalUncompressedBytes)
    throw new Error('APKG expanded size exceeds limit')

  const collectionEntries = entries.filter((entry) =>
    ['collection.anki2', 'collection.anki21', 'collection.anki21b'].includes(
      entry.name,
    ),
  )
  if (collectionEntries.length !== 1)
    throw new Error('APKG must contain exactly one top-level collection')
  const collectionEntry = collectionEntries[0]
  if (collectionEntry.name.includes('/'))
    throw new Error('Collection must be a top-level entry')
  const rawCollection = await collectionEntry.async('uint8array')
  const format =
    collectionEntry.name === 'collection.anki21b' ? 'modern' : 'legacy'
  const collection =
    format === 'modern' || isZstd(rawCollection)
      ? decompress(rawCollection)
      : rawCollection
  if (collection.byteLength > limits.collectionBytes)
    throw new Error('Collection exceeds expanded size limit')

  let packageVersion: number | null = null
  const metaEntry = zip.file('meta')
  if (metaEntry)
    packageVersion = decodePackageVersion(await metaEntry.async('uint8array'))
  let media: Record<string, string> = {}
  const mediaEntry = zip.file('media')
  if (mediaEntry) {
    let mediaBytes = await mediaEntry.async('uint8array')
    if (isZstd(mediaBytes)) mediaBytes = decompress(mediaBytes)
    if (mediaBytes.byteLength > limits.mediaBytes)
      throw new Error('Media manifest exceeds size limit')
    if (format === 'modern') media = decodeModernMediaMap(mediaBytes)
    else {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(mediaBytes))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Invalid media manifest')
      media = Object.fromEntries(
        Object.entries(parsed).filter(
          (pair): pair is [string, string] => typeof pair[1] === 'string',
        ),
      )
    }
  }
  const mediaFiles = new Map<string, Uint8Array>()
  let mediaTotal = 0
  for (const [key, filename] of Object.entries(media)) {
    if (!isSafeEntry(filename) || filename.includes('/'))
      throw new Error(`Unsafe media filename: ${filename}`)
    const entry = zip.file(key)
    if (!entry) continue
    let bytes = await entry.async('uint8array')
    if (format === 'modern' && isZstd(bytes)) bytes = decompress(bytes)
    mediaTotal += bytes.byteLength
    if (mediaTotal > limits.mediaBytes)
      throw new Error('Media files exceed expanded size limit')
    mediaFiles.set(filename, bytes)
  }
  return { format, collection, media, mediaFiles, packageVersion }
}
