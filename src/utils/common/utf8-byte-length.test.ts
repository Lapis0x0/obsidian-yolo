import { utf8ByteLength } from './utf8-byte-length'

describe('utf8ByteLength', () => {
  it.each([
    ['empty', ''],
    ['ASCII', 'data:image/png;base64,AAAA'],
    ['two-byte', 'café ñ'],
    ['three-byte', '你好，世界'],
    ['astral (surrogate pair)', 'a😀b𝄞'],
    ['lone high surrogate', 'x\uD83Dy'],
    ['lone low surrogate at end', 'x\uDE00'],
  ])('matches TextEncoder for %s text', (_label, text) => {
    expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).byteLength)
  })
})
