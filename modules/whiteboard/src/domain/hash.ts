// A short, stable name for a piece of text: what the board keeps pictures
// under (host/pictureStore.ts) and what it tells two versions of a card apart
// by (ui/pictures/). Not cryptographic — two different texts given the same
// name is a picture shown for the wrong version, once in about 2^53.

/**
 * cyrb53 of `text`, in base 36: plain lowercase letters and digits, which is
 * also what a storage key segment has to be.
 *
 * `seed` starts a second, independent name for the same text — and lets a
 * name be built up over several pieces without joining them first
 * (`hashText(b, hashText(a))`).
 */
export function hashText(text: string, seed = ''): string {
  const hasher = new TextHasher()
  if (seed !== '') {
    hasher.update(seed)
    // Apart from the text, so that ('ab', 'c') and ('a', 'bc') differ.
    hasher.update('\u0000')
  }
  hasher.update(text)
  return hasher.digest()
}

/**
 * `hashText`'s name for a text given a piece at a time: the name of all the
 * pieces joined, for a text too long to go over in one go — a stylesheet,
 * named across idle slices (ui/pictures/pictureStyles.ts).
 */
export class TextHasher {
  private h1 = 0xdeadbeef
  private h2 = 0x41c6ce57

  /** Goes over `text` from `from` up to `to`. */
  update(text: string, from = 0, to = text.length): void {
    // Kept in locals over the loop: a stylesheet runs to most of a million
    // characters, and fields read and written per character cost several
    // times the loop itself.
    let h1 = this.h1
    let h2 = this.h2
    for (let i = from; i < to; i++) {
      const ch = text.charCodeAt(i)
      h1 = Math.imul(h1 ^ ch, 2654435761)
      h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    this.h1 = h1
    this.h2 = h2
  }

  digest(): string {
    let h1 = this.h1
    let h2 = this.h2
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
  }
}
