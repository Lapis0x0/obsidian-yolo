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
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  const mix = (piece: string): void => {
    for (let i = 0; i < piece.length; i++) {
      const ch = piece.charCodeAt(i)
      h1 = Math.imul(h1 ^ ch, 2654435761)
      h2 = Math.imul(h2 ^ ch, 1597334677)
    }
  }
  if (seed !== '') {
    mix(seed)
    // Apart from the text, so that ('ab', 'c') and ('a', 'bc') differ.
    mix('\u0000')
  }
  mix(text)
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
