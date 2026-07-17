import {
  RELEASE_FILE_NAMES,
  parseStylesBakedVersion,
} from './installationIntegrity'

describe('parseStylesBakedVersion', () => {
  it('parses the version banner from the first line', () => {
    const css = '/* @yolo-version: 1.5.12.2 */\n.yolo {}'
    expect(parseStylesBakedVersion(css)).toBe('1.5.12.2')
  })

  it('returns null when the banner is missing', () => {
    expect(parseStylesBakedVersion('.yolo {}')).toBeNull()
  })
})

describe('RELEASE_FILE_NAMES', () => {
  it('lists the three plugin release artifacts', () => {
    expect(RELEASE_FILE_NAMES).toEqual({
      mainJs: 'main.js',
      manifestJson: 'manifest.json',
      stylesCss: 'styles.css',
    })
  })
})
