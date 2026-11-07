// The own sizes of the images cards embed, for the typesetter to lay them
// out by (../typesetting/typesetter.ts): what an embed names, resolved to a
// file the way Obsidian resolves it, and that file's size, read from its
// header (../../domain/imageSize.ts) once and kept until the file changes.

import { type ImageSize, imageSize } from '../../domain/imageSize'

export type ImageSizesDeps = Readonly<{
  vault: Pick<YoloModuleHostApiV1['vault'], 'resolveLink' | 'readBinary'>
  /** The document embeds are resolved against: the board's file. */
  sourcePath: () => string
}>

export class ImageSizes {
  /** Per file: its size, null when it has none to read, or a promise while
   * it is being read. */
  private readonly sizes = new Map<string, ImageSize | null | Promise<void>>()

  constructor(private readonly deps: ImageSizesDeps) {}

  /** The file `target` names, or null when it names none. */
  resolve(target: string): string | null {
    if (/^[a-z][\w+.-]*:/i.test(target)) return null
    return (
      this.deps.vault.resolveLink(target, this.deps.sourcePath())?.path ?? null
    )
  }

  /** A file's size; null when it has none; undefined while it is read. */
  get(path: string): ImageSize | null | undefined {
    const known = this.sizes.get(path)
    if (known === undefined) {
      this.sizes.set(path, this.load(path))
      return undefined
    }
    return known instanceof Promise ? undefined : known
  }

  /** A file changed: its size is read again when next asked for. */
  fileChanged(path: string): void {
    this.sizes.delete(path)
  }

  private async load(path: string): Promise<void> {
    let size: ImageSize | null = null
    try {
      size = imageSize(new Uint8Array(await this.deps.vault.readBinary(path)))
    } catch {
      size = null
    }
    // Asked for again by the card waiting on it, on a later frame.
    this.sizes.set(path, size)
  }
}
