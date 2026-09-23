// "Export with annotations": a copy of a PDF, beside it, with its
// annotations (../domain/pdfAnnotations.ts) written in as standard PDF
// annotations, so they travel with the file into any PDF viewer. The PDF
// itself is never written — the annotation file stays the source of truth,
// and the copy is a snapshot of it.

import {
  basenameWithoutExtension,
  folderPathOf,
  generateAnnotatedPdfFileName,
} from '../domain/naming'
import { toExportedAnnotations } from '../domain/pdfExport'
import { createWhiteboardTranslation } from '../i18n'

import type { AnnotationStores } from './annotationStore'

export async function exportAnnotatedPdf(
  host: YoloModuleHostApiV1,
  stores: AnnotationStores,
  pdfPath: string,
): Promise<void> {
  const t = createWhiteboardTranslation(host.i18n.getSnapshot().locale)
  try {
    const annotations = await stores.read(pdfPath)
    if (annotations.length === 0) {
      host.ui.notice(t('notice.exportNoAnnotations'))
      return
    }
    const output = await host.pdf.addAnnotations(
      await host.vault.readBinary(pdfPath),
      toExportedAnnotations(annotations),
    )
    const folder = folderPathOf(pdfPath)
    const taken = new Set(
      host.vault
        .listChildren(folder)
        .filter((entry) => entry.kind === 'file')
        .map((entry) => entry.name),
    )
    const name = generateAnnotatedPdfFileName(
      basenameWithoutExtension(pdfPath),
      taken,
    )
    const target = folder ? `${folder}/${name}` : name
    await host.vault.createBinary(target, output)
    host.ui.notice(t('notice.exportedAnnotatedPdf').replace('{path}', target))
  } catch (error) {
    console.error(
      `[YOLO Whiteboard] exporting "${pdfPath}" with annotations failed`,
      error,
    )
    host.ui.notice(t('error.exportAnnotatedPdfFailed'))
  }
}
