import { getTextAttachmentKind } from '../../../../utils/llm/text-attachment'

export type ClassifiedUploadFiles = {
  imageFiles: File[]
  pdfFiles: File[]
  officeFiles: File[]
  textAttachmentFiles: File[]
  unsupportedFiles: File[]
}

export function classifyUploadFiles(files: File[]): ClassifiedUploadFiles {
  const imageFiles: File[] = []
  const pdfFiles: File[] = []
  const officeFiles: File[] = []
  const textAttachmentFiles: File[] = []
  const unsupportedFiles: File[] = []

  for (const file of files) {
    if (file.type.startsWith('image/')) {
      imageFiles.push(file)
    } else if (isPdfFile(file)) {
      pdfFiles.push(file)
    } else if (isOfficeFile(file)) {
      officeFiles.push(file)
    } else if (isTextAttachmentFile(file)) {
      textAttachmentFiles.push(file)
    } else {
      unsupportedFiles.push(file)
    }
  }

  return {
    imageFiles,
    pdfFiles,
    officeFiles,
    textAttachmentFiles,
    unsupportedFiles,
  }
}

export function getFilesFromClipboardData(clipboardData: DataTransfer): File[] {
  const itemFiles = Array.from(clipboardData.items ?? []).flatMap((item) => {
    if (item.kind !== 'file') return []
    const file = item.getAsFile()
    return file ? [file] : []
  })

  if (itemFiles.length > 0) {
    return dedupeFiles(itemFiles)
  }

  return dedupeFiles(Array.from(clipboardData.files ?? []))
}

function dedupeFiles(files: File[]): File[] {
  const result: File[] = []
  const seen = new Set<string>()

  files.forEach((file) => {
    const key = `${file.name}:${file.type}:${file.size}`
    if (seen.has(key)) return
    seen.add(key)
    result.push(file)
  })

  return result
}

function isPdfFile(file: File): boolean {
  return (
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  )
}

function isOfficeFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return (
    name.endsWith('.docx') || name.endsWith('.pptx') || name.endsWith('.xlsx')
  )
}

function isTextAttachmentFile(file: File): boolean {
  return getTextAttachmentKind(file) !== null
}
