import type { TtsSynthesisFileResult } from '../../../../core/tts/types'
import { extensionForAudioFormat } from '../../../../core/tts/utils'

export const GENERATED_AUDIO_DRAG_MIME = 'application/x-yolo-read-aloud-audio'

export type GeneratedAudioDragSegment = {
  segmentIndex: number
  audio: TtsSynthesisFileResult
  savedPath: string | null
  sourceName: string
}

export function applyGeneratedAudioDragData(
  event: DragEvent,
  segment: GeneratedAudioDragSegment,
): boolean {
  const dataTransfer = event.dataTransfer
  if (!dataTransfer) return false

  const fileName = buildGeneratedAudioFileName(segment)
  const blob = new Blob([segment.audio.bytes], { type: segment.audio.mimeType })
  // The audio-file transcription drop handler also watches audio File items.
  // Mark plugin-generated read-aloud drags so that handler can step aside and
  // let editor/file-list drops receive the generated audio or markdown embed.
  dataTransfer.setData(GENERATED_AUDIO_DRAG_MIME, '1')
  let addedFile = false
  try {
    const file = new File([blob], fileName, { type: segment.audio.mimeType })
    dataTransfer.items?.add(file)
    addedFile = true
  } catch {
    // Some Electron/Chromium builds reject programmatic file items. Text
    // payloads below still let Obsidian editors receive a usable embed.
  }

  if (segment.savedPath) {
    const markdown = `![[${segment.savedPath}]]`
    dataTransfer.setData('text/plain', markdown)
    dataTransfer.setData('text/markdown', markdown)
  } else {
    // Without a vault path, a markdown embed would create a dangling
    // `selection.mp3` link. Let destinations that understand File items
    // receive the blob, and cancel the drag in environments that reject it.
    if (!addedFile) return false
  }
  dataTransfer.effectAllowed = 'copy'
  return true
}

const buildGeneratedAudioFileName = (
  segment: GeneratedAudioDragSegment,
): string => {
  const base =
    segment.sourceName.replace(/[\\/:*?"<>|]/g, '-').trim() || 'read-aloud'
  const suffix =
    segment.segmentIndex > 0
      ? `-${String(segment.segmentIndex + 1).padStart(3, '0')}`
      : ''
  return `${base}${suffix}.${extensionForAudioFormat(segment.audio.format)}`
}
