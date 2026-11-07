// The own sizes of the images cards embed, for the typesetter to lay them
// out by (../typesetting/typesetter.ts): what an embed names, resolved to a
// file the way Obsidian resolves it, and that file's size, read from its
// header (../../domain/imageSize.ts) once and kept until the file changes.

import { type ImageSize, imageSize } from '../../domain/imageSize'
import { type RemoteImages, remoteImageKey } from '../../host/remoteImages'
import { isRemoteImage } from '../../typeset/images'

export type ImageSizesDeps = Readonly<{
  vault: Pick<YoloModuleHostApiV1['vault'], 'resolveLink' | 'readBinary'>
  /** The document embeds are resolved against: the board's file. */
  sourcePath: () => string
  /** Images on the web, as cards' DOM showed them. */
  remote: Pick<RemoteImages, 'get' | 'kept'>
}>

export class ImageSizes {
  /** Per file: its size, null when it has none to read, or a promise while
   * it is being read. */
  private readonly sizes = new Map<string, ImageSize | null | Promise<void>>()

  constructor(private readonly deps: ImageSizesDeps) {}

  /** The file `target` names, or null when it names none; an image on the
   * web, its address. */
  resolve(target: string): string | null {
    if (isRemoteImage(target)) return remoteImageKey(target)
    if (/^[a-z][\w+.-]*:/i.test(target)) return null
    return (
      this.deps.vault.resolveLink(target, this.deps.sourcePath())?.path ?? null
    )
  }

  /** A file's size; null when it has none; undefined while it is read. */
  get(path: string): ImageSize | null | undefined {
    // An image on the web is known once a card's DOM has shown it.
    if (isRemoteImage(path)) return this.deps.remote.get(path)
    const known = this.sizes.get(path)
    if (known === undefined) {
      this.sizes.set(path, this.load(path))
      return undefined
    }
    return known instanceof Promise ? undefined : known
  }

  /** Whether the image can be drawn other than by the browser: a file
   * always; an image on the web once its bytes are kept. */
  drawable(path: string): boolean {
    return !isRemoteImage(path) || this.deps.remote.kept(path)
  }

  /** A file's size, once it is read. */
  async sizeOf(path: string): Promise<ImageSize | null> {
    const now = this.get(path)
    if (now !== undefined) return now
    await this.sizes.get(path)
    return this.get(path) ?? null
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
