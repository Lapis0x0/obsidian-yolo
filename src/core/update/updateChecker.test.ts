import { type RequestUrlResponse, requestUrl } from 'obsidian'

import {
  buildReleaseAssets,
  checkForUpdate,
  compareVersions,
  fetchReleaseHistoryPage,
  locateReleaseHistoryPage,
  normalizePluginVersion,
  parseChangelog,
  parseLatestVersionFromVersionsJson,
  parseReleaseAssets,
  parseReleaseNoteVersion,
  splitReleaseNotesByLanguage,
} from './updateChecker'

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>

function createRequestUrlResponse(text: string): RequestUrlResponse {
  let json: unknown = null
  try {
    json = JSON.parse(text) as unknown
  } catch {
    json = null
  }

  return {
    status: 200,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json,
    text,
  }
}

describe('parseLatestVersionFromVersionsJson', () => {
  it('returns the highest normalized version key', () => {
    expect(
      parseLatestVersionFromVersionsJson(
        JSON.stringify({
          '1.5.9': '1.8.0',
          '1.5.12.4': '1.8.0',
          v1: 'ignored',
          '1.5.12.5': '1.8.0',
          next: 'ignored',
        }),
      ),
    ).toBe('1.5.12.5')
  })

  it('returns null for invalid JSON or non-object payloads', () => {
    expect(parseLatestVersionFromVersionsJson('not-json')).toBeNull()
    expect(parseLatestVersionFromVersionsJson('[]')).toBeNull()
  })
})

describe('checkForUpdate', () => {
  const asset = (name: string) => ({
    name,
    mirrorPath: `core/1.5.12.5/${name}`,
    canonicalUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/1.5.12.5/${name}`,
    byteSize: 10,
    sha256: 'a'.repeat(64),
  })
  const feedClient = {
    loadFresh: jest.fn(async () => ({
      core: {
        version: '1.5.12.5',
        minAppVersion: '1.8.0',
        releaseUrl:
          'https://github.com/Lapis0x0/obsidian-yolo/releases/tag/1.5.12.5',
        releaseNotes: {
          en: '## 1.5.12.5 Update Toast Notes ✨',
          zh: '## 1.5.12.5 更新提示说明 ✨',
        },
        assets: {
          mainJs: asset('main.js'),
          manifestJson: asset('manifest.json'),
          stylesCss: asset('styles.css'),
        },
      },
      modules: [],
    })),
  }

  beforeEach(() => {
    feedClient.loadFresh.mockClear()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => jest.restoreAllMocks())

  it('uses signed Feed metadata for the latest Core', async () => {
    await expect(
      checkForUpdate('1.5.12.4', feedClient as never),
    ).resolves.toEqual({
      hasUpdate: true,
      latestVersion: '1.5.12.5',
      releaseNotes: {
        en: '## 1.5.12.5 Update Toast Notes ✨',
        zh: '## 1.5.12.5 更新提示说明 ✨',
      },
      releaseUrl:
        'https://github.com/Lapis0x0/obsidian-yolo/releases/tag/1.5.12.5',
      assets: {
        mainJs: {
          url: asset('main.js').canonicalUrl,
          mirrorUrl: 'https://updates.yoloapp.dev/core/1.5.12.5/main.js',
          size: 10,
          sha256: 'a'.repeat(64),
        },
        manifestJson: {
          url: asset('manifest.json').canonicalUrl,
          mirrorUrl: 'https://updates.yoloapp.dev/core/1.5.12.5/manifest.json',
          size: 10,
          sha256: 'a'.repeat(64),
        },
        stylesCss: {
          url: asset('styles.css').canonicalUrl,
          mirrorUrl: 'https://updates.yoloapp.dev/core/1.5.12.5/styles.css',
          size: 10,
          sha256: 'a'.repeat(64),
        },
      },
    })
    expect(feedClient.loadFresh).toHaveBeenCalledTimes(1)
  })

  it('hides release notes when the installed Core is current', async () => {
    await expect(
      checkForUpdate('1.5.12.5', feedClient as never),
    ).resolves.toMatchObject({
      hasUpdate: false,
      latestVersion: '1.5.12.5',
      releaseNotes: { en: null, zh: null },
    })
  })

  it('returns null when all validated Feed sources are unavailable', async () => {
    feedClient.loadFresh.mockRejectedValueOnce(new Error('unavailable'))
    await expect(
      checkForUpdate('1.5.12.4', feedClient as never),
    ).resolves.toBeNull()
    expect(console.warn).toHaveBeenCalledWith(
      '[YOLO] Plugin update check failed: unavailable',
    )
  })
})

describe('parseReleaseAssets', () => {
  it('returns URLs and sizes when all three release assets are present', () => {
    const result = parseReleaseAssets([
      {
        name: 'main.js',
        browser_download_url: 'https://github.com/example/main.js',
        size: 12345,
      },
      {
        name: 'manifest.json',
        browser_download_url: 'https://github.com/example/manifest.json',
        size: 256,
      },
      {
        name: 'styles.css',
        browser_download_url: 'https://github.com/example/styles.css',
        size: 4096,
      },
    ])
    expect(result).toEqual({
      mainJs: { url: 'https://github.com/example/main.js', size: 12345 },
      manifestJson: {
        url: 'https://github.com/example/manifest.json',
        size: 256,
      },
      stylesCss: { url: 'https://github.com/example/styles.css', size: 4096 },
    })
  })

  it('defaults missing size to 0', () => {
    const result = parseReleaseAssets([
      {
        name: 'main.js',
        browser_download_url: 'https://github.com/example/main.js',
      },
      {
        name: 'manifest.json',
        browser_download_url: 'https://github.com/example/manifest.json',
      },
      {
        name: 'styles.css',
        browser_download_url: 'https://github.com/example/styles.css',
      },
    ])
    expect(result?.mainJs.size).toBe(0)
  })

  it('returns null when a required asset is missing', () => {
    expect(
      parseReleaseAssets([
        {
          name: 'main.js',
          browser_download_url: 'https://github.com/example/main.js',
        },
      ]),
    ).toBeNull()
  })

  it('returns null for non-array input', () => {
    expect(parseReleaseAssets(undefined)).toBeNull()
  })
})

describe('buildReleaseAssets', () => {
  it('builds deterministic release asset URLs for a version', () => {
    expect(buildReleaseAssets('v1.5.12.2')).toEqual({
      mainJs: {
        url: 'https://github.com/Lapis0x0/obsidian-yolo/releases/download/1.5.12.2/main.js',
        size: 0,
      },
      manifestJson: {
        url: 'https://github.com/Lapis0x0/obsidian-yolo/releases/download/1.5.12.2/manifest.json',
        size: 0,
      },
      stylesCss: {
        url: 'https://github.com/Lapis0x0/obsidian-yolo/releases/download/1.5.12.2/styles.css',
        size: 0,
      },
    })
  })

  it('returns null for an empty version', () => {
    expect(buildReleaseAssets('')).toBeNull()
  })
})

describe('normalizePluginVersion', () => {
  it('strips v prefix and trims whitespace', () => {
    expect(normalizePluginVersion(' v1.5.11.1 ')).toBe('1.5.11.1')
  })
})

describe('parseReleaseNoteVersion', () => {
  it('extracts the version from the first markdown heading', () => {
    expect(
      parseReleaseNoteVersion('Intro\n\n## v1.5.12.5 Update Notes ✨'),
    ).toBe('1.5.12.5')
  })

  it('returns null when no heading starts with a version', () => {
    expect(parseReleaseNoteVersion('## Update Notes')).toBeNull()
  })

  it('does not skip a non-version first heading', () => {
    expect(
      parseReleaseNoteVersion('## Update Notes\n\n## 1.5.12.5 Real Version'),
    ).toBeNull()
  })
})

describe('compareVersions', () => {
  it('returns true when latest is newer (patch)', () => {
    expect(compareVersions('1.5.4.7', '1.5.4.8')).toBe(true)
  })

  it('returns true when latest is newer (minor)', () => {
    expect(compareVersions('1.5.4.7', '1.6.0')).toBe(true)
  })

  it('returns false when equal', () => {
    expect(compareVersions('1.5.4.7', '1.5.4.7')).toBe(false)
  })

  it('returns false when latest is older', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(false)
  })

  it('strips v prefix on tags', () => {
    expect(compareVersions('1.0.0', 'v1.0.1')).toBe(true)
  })
})

describe('splitReleaseNotesByLanguage', () => {
  it('splits the standard EN --- ZH bilingual body', () => {
    const body = [
      '## 1.6.0 Pop-out Chat',
      '',
      '- **New Feature**: something useful (#360)',
      '',
      '---',
      '',
      '## 1.6.0 独立窗口聊天',
      '',
      '- **新功能**：很有用的东西（#360）',
    ].join('\n')

    const result = splitReleaseNotesByLanguage(body)
    expect(result.en).toContain('Pop-out Chat')
    expect(result.en).not.toContain('独立窗口')
    expect(result.zh).toContain('独立窗口聊天')
    expect(result.zh).not.toContain('Pop-out Chat')
  })

  it('classifies by CJK ratio regardless of section order', () => {
    const body = [
      '## 中文在前的更新说明',
      '- 一些改动',
      '---',
      '## English second',
    ].join('\n')
    const result = splitReleaseNotesByLanguage(body)
    expect(result.zh).toContain('中文在前')
    expect(result.en).toContain('English second')
  })

  it('returns only one language when no bilingual split exists', () => {
    const result = splitReleaseNotesByLanguage(
      '## 1.6.0\n- English only release',
    )
    expect(result.en).toContain('English only')
    expect(result.zh).toBeNull()
  })

  it('returns both null for an empty body', () => {
    expect(splitReleaseNotesByLanguage('')).toEqual({ en: null, zh: null })
  })

  it('handles a real release body whose Chinese section is dense with markdown / inline code / #refs', () => {
    const body = [
      '## 1.5.9.4 Pop-out Chat & Context Clarity ✨',
      '',
      '### 🎨 UX Polish',
      '',
      '- **Desktop Request Transport Auto Mode**: Auto mode on desktop no longer falls back to Obsidian `requestUrl`; only the node → browser chain is used.',
      '',
      '---',
      '',
      '## 1.5.9.4 独立窗口聊天与上下文拆分 ✨',
      '',
      '### 🎨 体验优化',
      '',
      '- **桌面端请求传输自动模式**：自动模式不再回退到 Obsidian `requestUrl`，仅保留 node → browser 链路，提高请求稳定性。',
    ].join('\n')

    const result = splitReleaseNotesByLanguage(body)
    expect(result.en).toContain('Desktop Request Transport Auto Mode')
    expect(result.en).not.toContain('体验优化')
    expect(result.zh).toContain('桌面端请求传输自动模式')
    expect(result.zh).not.toContain('Pop-out Chat')
  })
})

describe('parseChangelog', () => {
  const ZH = [
    '## 1.5.9.4 独立窗口聊天与上下文拆分 ✨',
    '',
    '### ✨ 新功能',
    '',
    '- **上下文「思考过程」拆分（#360）**：上下文占用 popover 新增「思考过程」分类。',
    '',
    '### 🎨 体验优化',
    '',
    '- **桌面端请求传输自动模式**：自动模式不再回退到 Obsidian `requestUrl`。',
    '',
    '### 🐛 Bug 修复',
    '',
    '- **独立窗口聊天无法输入**：修复 pop-out 后无法输入的问题。',
  ].join('\n')

  it('strips the version and trailing emoji from the subtitle', () => {
    expect(parseChangelog(ZH).subtitle).toBe('独立窗口聊天与上下文拆分')
  })

  it('splits sections and maps the leading emoji to a tone', () => {
    const { sections } = parseChangelog(ZH)
    expect(sections.map((s) => [s.name, s.tone])).toEqual([
      ['新功能', 'accent'],
      ['体验优化', 'teal'],
      ['Bug 修复', 'rose'],
    ])
  })

  it('extracts the title, fullwidth-paren ref and body of an item', () => {
    const item = parseChangelog(ZH).sections[0].items[0]
    expect(item.title).toBe('上下文「思考过程」拆分')
    expect(item.ref).toBe('#360')
    expect(item.body).toContain('「思考过程」分类')
  })

  it('keeps inline code untouched in the body for the renderer', () => {
    const item = parseChangelog(ZH).sections[1].items[0]
    expect(item.body).toContain('`requestUrl`')
  })

  it('parses the English body with a halfwidth-paren ref', () => {
    const en = [
      '## 1.5.9.4 Pop-out Chat & Context Clarity ✨',
      '### ✨ New Features',
      '- **Context Usage Thinking Breakdown (#360)**: A clearer breakdown.',
    ].join('\n')
    const item = parseChangelog(en).sections[0].items[0]
    expect(parseChangelog(en).subtitle).toBe('Pop-out Chat & Context Clarity')
    expect(item.title).toBe('Context Usage Thinking Breakdown')
    expect(item.ref).toBe('#360')
  })

  it('gathers leading bullets into an unnamed section when no heading precedes them', () => {
    const { sections } = parseChangelog('- **Loose note**: no section heading.')
    expect(sections).toHaveLength(1)
    expect(sections[0].name).toBe('')
    expect(sections[0].items[0].title).toBe('Loose note')
  })

  it('handles asterisk bullet markers (older release style) and the 🔧 tone', () => {
    const body = [
      '## 1.5.9.1 工具按需加载默认关闭 & 工具中断修复 🛠️',
      '### 🔧 调整',
      '*   **工具按需加载默认关闭（#340）**：`mcp.enableToolDisclosure` 默认关闭。',
    ].join('\n')
    const { subtitle, sections } = parseChangelog(body)
    // trailing 🛠️ (with variation selector) stripped from the subtitle
    expect(subtitle).toBe('工具按需加载默认关闭 & 工具中断修复')
    expect(sections[0].name).toBe('调整')
    expect(sections[0].tone).toBe('amber')
    const item = sections[0].items[0]
    expect(item.title).toBe('工具按需加载默认关闭')
    expect(item.ref).toBe('#340')
    expect(item.body).toContain('`mcp.enableToolDisclosure`')
  })

  it('extracts a multi-ref group as a single ref string', () => {
    const item = parseChangelog(
      '### 🐛 Bug Fixes\n*   **js_eval UMD 加载与调试报错（#354、#355）**：修复加载失败。',
    ).sections[0].items[0]
    expect(item.title).toBe('js_eval UMD 加载与调试报错')
    expect(item.ref).toBe('#354、#355')
  })
})

describe('release history products', () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset()
  })

  it('mixes Core and official module releases while excluding unrelated tags', async () => {
    mockedRequestUrl.mockResolvedValue(
      createRequestUrlResponse(
        JSON.stringify([
          {
            tag_name: 'learning/v0.1.0',
            body: '## 0.1.0 Learning update',
            html_url: 'https://example.test/learning',
            draft: false,
            prerelease: false,
          },
          {
            tag_name: '1.6.0.4',
            body: '## 1.6.0.4 Core update',
            html_url: 'https://example.test/core',
            draft: false,
            prerelease: false,
          },
          {
            tag_name: 'runtime/v1.0.0',
            body: 'runtime',
            draft: false,
            prerelease: true,
          },
          {
            tag_name: 'internal-build',
            body: 'internal',
            draft: false,
            prerelease: false,
          },
        ]),
      ),
    )

    await expect(fetchReleaseHistoryPage(1)).resolves.toMatchObject({
      entries: [
        {
          productId: 'learning',
          productName: 'Learning',
          version: '0.1.0',
        },
        {
          productId: 'core',
          productName: 'YOLO Core',
          version: '1.6.0.4',
        },
      ],
      hasNext: false,
    })
  })

  it('does not mistake a module version for the installed Core version', async () => {
    mockedRequestUrl.mockResolvedValue(
      createRequestUrlResponse(
        JSON.stringify([
          {
            tag_name: 'learning/v0.1.0',
            body: '## 0.1.0 Learning update',
            draft: false,
            prerelease: false,
          },
        ]),
      ),
    )

    await expect(locateReleaseHistoryPage('0.1.0')).resolves.toMatchObject({
      pageIndex: 0,
      found: false,
    })
  })
})
