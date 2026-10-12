import { cardStamp, takenIn } from './cardPictures'
import type { StyleEnvironment } from './pictureStyles'

const env = (hash: string): StyleEnvironment => ({
  hash,
  bodyClass: '',
  vars: new Map(),
  font: { family: '', size: '', lineHeight: '', color: '' },
})

describe('card picture stamps', () => {
  it('is taken in the environment it was asked for in', () => {
    expect(takenIn(cardStamp('text.abc', env('light')), env('light'))).toBe(
      true,
    )
  })

  it('is not taken once the environment has changed', () => {
    expect(takenIn(cardStamp('text.abc', env('light')), env('dark'))).toBe(
      false,
    )
  })
})
