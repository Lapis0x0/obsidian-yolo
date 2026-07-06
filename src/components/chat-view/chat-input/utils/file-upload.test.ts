import { classifyUploadFiles, getFilesFromClipboardData } from './file-upload'

function fakeFile(
  name: string,
  type: string,
  options?: { size?: number; lastModified?: number },
): File {
  return {
    name,
    type,
    size: options?.size ?? 1,
    lastModified: options?.lastModified ?? 1,
  } as File
}

describe('classifyUploadFiles', () => {
  it('classifies images, PDFs, Office docs, text attachments, and unsupported files', () => {
    const image = fakeFile('image.png', 'image/png')
    const typedPdf = fakeFile('doc.pdf', 'application/pdf')
    const extensionPdf = fakeFile('scanned.PDF', '')
    const docx = fakeFile('report.docx', '')
    const pptx = fakeFile('slides.PPTX', '')
    const xlsx = fakeFile('budget.xlsx', '')
    const txt = fakeFile('note.txt', 'text/plain')
    const md = fakeFile('README.md', '')
    const csv = fakeFile('rows.CSV', '')
    const yaml = fakeFile('config.yaml', '')
    const unsupported = fakeFile('archive.zip', 'application/zip')

    expect(
      classifyUploadFiles([
        image,
        typedPdf,
        extensionPdf,
        docx,
        pptx,
        xlsx,
        txt,
        md,
        csv,
        yaml,
        unsupported,
      ]),
    ).toEqual({
      imageFiles: [image],
      pdfFiles: [typedPdf, extensionPdf],
      officeFiles: [docx, pptx, xlsx],
      textAttachmentFiles: [txt, md, csv, yaml],
      unsupportedFiles: [unsupported],
    })
  })
})

describe('getFilesFromClipboardData', () => {
  it('prefers clipboard item files over mirrored clipboard files', () => {
    const itemImage = fakeFile('image.png', 'image/png', {
      size: 12,
      lastModified: 34,
    })
    const mirroredImage = fakeFile('image.png', 'image/png', {
      size: 12,
      lastModified: 56,
    })
    const clipboardData = {
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => itemImage },
      ],
      files: [mirroredImage],
    } as unknown as DataTransfer

    expect(getFilesFromClipboardData(clipboardData)).toEqual([itemImage])
  })

  it('falls back to clipboard files when items do not expose files', () => {
    const image = fakeFile('image.png', 'image/png')
    const pdf = fakeFile('doc.pdf', 'application/pdf')
    const clipboardData = {
      items: [{ kind: 'string', getAsFile: () => null }],
      files: [image, pdf],
    } as unknown as DataTransfer

    expect(getFilesFromClipboardData(clipboardData)).toEqual([image, pdf])
  })
})
