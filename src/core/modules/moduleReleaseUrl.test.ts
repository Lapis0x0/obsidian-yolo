import {
  OFFICIAL_MODULE_RELEASE_REPOSITORIES,
  isModuleReleaseUrlAllowed,
  parseModuleReleaseUrl,
} from './moduleReleaseUrl'

const repository = [{ owner: 'Lapis0x0', repo: 'obsidian-yolo' }]
const root = 'https://github.com/Lapis0x0/obsidian-yolo/releases/download'

describe('module release URL contract', () => {
  it.each([
    ['module-learning-v0.1.0', 'module-learning-v0.1.0'],
    ['learning%2Fv0.1.0', 'learning%2Fv0.1.0'],
    ['learning%2fv0.1.0', 'learning%2Fv0.1.0'],
  ])('accepts and canonicalizes tag %s', (tag, encodedTag) => {
    const parsed = parseModuleReleaseUrl(`${root}/${tag}/entry.js`)
    expect(parsed).toMatchObject({
      repositoryKey: 'lapis0x0/obsidian-yolo',
      encodedTag,
      assetName: 'entry.js',
      releaseParent: `lapis0x0/obsidian-yolo/${encodedTag}`,
    })
    expect(
      isModuleReleaseUrlAllowed(`${root}/${tag}/entry.js`, repository),
    ).toBe(true)
  })

  it('preserves release-parent identity across assets and tags', () => {
    const parent = parseModuleReleaseUrl(
      `${root}/learning%2Fv0.1.0/module.json`,
    )?.releaseParent
    expect(
      parseModuleReleaseUrl(`${root}/learning%2fv0.1.0/entry.js`)
        ?.releaseParent,
    ).toBe(parent)
    expect(
      parseModuleReleaseUrl(`${root}/learning%2Fv0.1.1/entry.js`)
        ?.releaseParent,
    ).not.toBe(parent)
  })

  it.each([
    `${root}/learning/v0.1.0/entry.js`,
    `${root}/learning%252Fv0.1.0/entry.js`,
    `${root}/learning%2Fv0.1.0%2Fextra/entry.js`,
    `${root}/learning%2F../entry.js`,
    `${root}/learning%2F%2e%2e/entry.js`,
    `${root}/learning%5Cv0.1.0/entry.js`,
    `${root}/learning%2Fv0.1.0/%2e%2e`,
    `${root}/learning%2Fv0.1.0/CON.js`,
    `${root}/learning%2Fv0.1.0/entry.js?token=x`,
    `${root}/learning%2Fv0.1.0/entry.js#hash`,
    'https://user@github.com/Lapis0x0/obsidian-yolo/releases/download/v1/entry.js',
    'https://github.com/Lapis0x0/obsidian-yolo/releases/download//entry.js',
  ])('rejects unsafe URL %s', (url) => {
    expect(parseModuleReleaseUrl(url)).toBeNull()
    expect(isModuleReleaseUrlAllowed(url, repository)).toBe(false)
  })

  it('preserves the official owner and repository allowlist', () => {
    expect(
      isModuleReleaseUrlAllowed(
        'https://github.com/other/project/releases/download/learning%2Fv0.1.0/entry.js',
        repository,
      ),
    ).toBe(false)
  })

  it('accepts every URL in a staged Learning release manifest', () => {
    const rawParityInput = process.env.LEARNING_RELEASE_PARITY_INPUT
    if (!rawParityInput) return
    const { version, urls } = JSON.parse(rawParityInput) as {
      version: string
      urls: readonly string[]
    }
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(parseModuleReleaseUrl(url)?.encodedTag).toBe(
        `learning%2Fv${version}`,
      )
      expect(
        isModuleReleaseUrlAllowed(url, OFFICIAL_MODULE_RELEASE_REPOSITORIES),
      ).toBe(true)
    }
  })
})
