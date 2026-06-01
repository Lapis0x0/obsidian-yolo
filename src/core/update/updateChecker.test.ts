import {
  compareVersions,
  parseChangelog,
  splitReleaseNotesByLanguage,
} from './updateChecker'

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
