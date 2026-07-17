import type {
  MentionableTextAttachment,
  TextAttachmentKind,
} from '../../types/mentionable'

export const TEXT_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024

const EXTENSION_TO_KIND: Record<string, TextAttachmentKind> = {
  txt: 'txt',
  md: 'md',
  markdown: 'md',
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  yaml: 'yaml',
  yml: 'yml',
  xml: 'xml',
  log: 'log',
}

export const TEXT_ATTACHMENT_EXTENSIONS = Object.keys(EXTENSION_TO_KIND)

export function getTextAttachmentKind(file: File): TextAttachmentKind | null {
  const lower = file.name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return null
  const ext = lower.slice(dot + 1)
  return EXTENSION_TO_KIND[ext] ?? null
}

function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export async function fileToMentionableTextAttachment(
  file: File,
): Promise<MentionableTextAttachment> {
  const kind = getTextAttachmentKind(file)
  if (!kind) {
    throw new Error(`Unsupported text attachment type: ${file.name}`)
  }
  if (file.size > TEXT_ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `Text attachment too large (${file.size} bytes). Limit is ${TEXT_ATTACHMENT_MAX_BYTES} bytes.`,
    )
  }

  const buf = await file.arrayBuffer()
  const decoded = new TextDecoder('utf-8').decode(buf)
  return {
    type: 'text-attachment',
    name: file.name,
    kind,
    content: stripUtf8Bom(decoded),
  }
}
