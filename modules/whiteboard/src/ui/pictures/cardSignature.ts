// What a card's picture of itself (./cardPictures.ts) is a picture of: the
// fields of its node that change how its content looks, named by a hash.
// Joined with the style environment's (./pictureStyles.ts), it is the
// picture's stamp: a picture of another signature is not the card any more.
//
// Not its colour: a card's colour is its frame's, drawn around the picture by
// whoever shows it — except bare text, which is written in its colour.
// Not what a note embeds either: a note card's picture follows the note's own
// file, and goes stale when an image or a note it embeds changes only once
// the note itself does.

import type { BoardNode } from '../../domain/fileFormat'
import { hashText } from '../../domain/hash'
import { fileNodeKind } from '../../domain/naming'

const textSignatures = new WeakMap<BoardNode, string>()

/** Whether `node` is a card whose picture is of its content: a text card,
 * bare text, or a note. */
export function isCardPictured(node: BoardNode): boolean {
  return (
    node.type === 'text' ||
    (node.type === 'file' && fileNodeKind(node.file) === 'markdown')
  )
}

/**
 * The signature of `node`'s content, as of its file's `mtime` for a note;
 * null for a node whose content is no card picture's, or a note whose file
 * is not there.
 */
export function cardSignature(
  node: BoardNode,
  mtime: number | null,
): string | null {
  if (node.type === 'text') {
    // A node's fields never change in place: a new one is a new object.
    const known = textSignatures.get(node)
    if (known) return known
    const plain = node.plain === true
    const signature = hashText(
      JSON.stringify([
        'text',
        node.text,
        node.w,
        node.h,
        plain,
        node.autoWidth === true,
        node.startLine ?? 0,
        plain ? (node.color ?? null) : null,
      ]),
    )
    textSignatures.set(node, signature)
    return signature
  }
  if (node.type !== 'file' || fileNodeKind(node.file) !== 'markdown') {
    return null
  }
  if (mtime === null) return null
  return hashText(
    JSON.stringify([
      'note',
      node.file,
      mtime,
      node.startLine ?? 0,
      node.w,
      node.h,
    ]),
  )
}
