// A vault path's extension is signal enough on its own for the host to say
// "this isn't freeform text" — the same signal `fs_read` already hardcodes
// for pdf/docx/pptx/xlsx (see `fs_read/schema-helpers.ts`'s
// `getOfficeDocumentKindFromExtension`). Recognizing an extension string
// does not require importing the module that interprets its bytes; this file
// owns exactly that string-level boundary, shared by `fs_edit` and
// `fs_write` (both need it — "谁用它谁收留" only moves a helper into a
// single tool's own directory when that tool is its only consumer).
//
// The check this file backs is UNCONDITIONAL — independent of whether the
// owning module is installed or active
// (docs/plans/09-03-whiteboard-agent-tools/master.md D4 / Q11). The
// alternative (only blocking when the module happens to be active) would
// make the same fs_edit call on the same file behave differently on two
// machines depending on which modules are installed there — worse than a
// missing feature, because it's an inconsistency the model (and the user
// reading its output) has no way to predict. That's also why this is a
// static table rather than a query against `ModuleFileTextRendererRegistry`
// (D3's read-side registry): registration there is runtime/module-driven by
// design, and reusing it here would make the write-side guard only as
// reliable as "did the module happen to load before this call."

export type StructuredVaultFormat = Readonly<{
  /** Fully-qualified tool name the model should use instead of a text edit. */
  editTool: string
}>

/**
 * Extensions (lower-case, no leading dot) whose bytes are a structured
 * format some module reads and writes through its own protocol — never text
 * a model should string-replace or overwrite wholesale.
 */
export const STRUCTURED_VAULT_FORMATS: Readonly<
  Record<string, StructuredVaultFormat>
> = {
  yoloboard: { editTool: 'yolo_whiteboard__edit_board' },
}

/**
 * Mirrors `TFile.extension`: the substring after the last '.' in the file
 * name, lower-cased; '' when there is none. Vault paths reaching this are
 * already normalized by `validateVaultPath`, so no further cleanup is done
 * here.
 */
export function getVaultPathExtension(path: string): string {
  const fileName = path.slice(path.lastIndexOf('/') + 1)
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex === -1 ? '' : fileName.slice(dotIndex + 1).toLowerCase()
}

/**
 * Null when `path` is not a structured format. Otherwise the model-facing
 * denial message `fs_edit` / `fs_write` should return instead of touching
 * the file. English, not routed through i18n: this text is read by the
 * model, not the user (AGENTS.md — tool error text is a model-facing
 * exception to the user-visible-text i18n rule).
 */
export function describeStructuredVaultFormatDenial(
  path: string,
): string | null {
  const extension = getVaultPathExtension(path)
  const format = STRUCTURED_VAULT_FORMATS[extension]
  if (!format) {
    return null
  }
  return (
    `"${path}" is a .${extension} file — a structured format read and ` +
    `written through its own protocol, not freeform text. Editing it as ` +
    `text has a low success rate and can corrupt it, and bypasses that ` +
    `protocol entirely. Use ${format.editTool} instead.`
  )
}
