import { renderToStaticMarkup } from 'react-dom/server'

import { parseChangelog } from '../../core/update/updateChecker'

import { UpdateChangelogSections } from './UpdateChangelogSections'

describe('UpdateChangelogSections', () => {
  it('renders inline bold and code, including code nested inside bold', () => {
    const sections = parseChangelog(
      [
        '### 🎓 学习模式',
        '- 新增全新的**学习模式**，支持导入 **Anki `.apkg` 卡包**。',
      ].join('\n'),
    ).sections

    const html = renderToStaticMarkup(
      <UpdateChangelogSections sections={sections} separator="：" />,
    )

    expect(html).toContain(
      '<strong class="yolo-update-toast-strong">学习模式</strong>',
    )
    expect(html).toContain(
      '<strong class="yolo-update-toast-strong">Anki <code class="yolo-update-toast-code">.apkg</code> 卡包</strong>',
    )
    expect(html).not.toContain('**')
  })

  it('keeps unmatched inline markers as text', () => {
    const sections = parseChangelog(
      '### Notes\n- Keep **unfinished and `unclosed markers.',
    ).sections

    const html = renderToStaticMarkup(
      <UpdateChangelogSections sections={sections} separator=": " />,
    )

    expect(html).toContain('Keep **unfinished and `unclosed markers.')
  })
})
