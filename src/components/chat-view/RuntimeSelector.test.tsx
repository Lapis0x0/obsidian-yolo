jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          'sidebar.runtimeSelector.accessibleLabel': 'Chat backend: {runtime}',
          'sidebar.runtimeSelector.menuLabel': 'Chat backend',
          'sidebar.runtimeSelector.chatBadge': 'Chat',
          'sidebar.runtimeSelector.cliBadge': 'CLI',
          'sidebar.runtimeSelector.yoloLabel': 'YOLO Chat',
          'sidebar.runtimeSelector.yoloDescription':
            'Built-in YOLO chat runtime',
          'sidebar.runtimeSelector.claudeCodeLabel': 'Claude Code',
          'sidebar.runtimeSelector.claudeCodeDescription':
            'Claude Code on this device',
          'sidebar.runtimeSelector.codexLabel': 'Codex',
          'sidebar.runtimeSelector.codexDescription': 'Codex on this device',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

import { Platform } from 'obsidian'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  RuntimeSelector,
  getRuntimeSelectorOptions,
  resolveAvailableRuntimeId,
} from './RuntimeSelector'

describe('RuntimeSelector', () => {
  const originalIsDesktop = Platform.isDesktop

  afterEach(() => {
    Platform.isDesktop = originalIsDesktop
  })

  it('exposes all runtime backends on desktop', () => {
    expect(getRuntimeSelectorOptions(true).map((option) => option.id)).toEqual([
      'yolo',
      'claude-code',
      'codex',
    ])
    expect(resolveAvailableRuntimeId('claude-code', true)).toBe('claude-code')
    expect(resolveAvailableRuntimeId('codex', true)).toBe('codex')
  })

  it('exposes only YOLO and rejects CLI selections without desktop capability', () => {
    expect(getRuntimeSelectorOptions(false).map((option) => option.id)).toEqual(
      ['yolo'],
    )
    expect(resolveAvailableRuntimeId('yolo', false)).toBe('yolo')
    expect(resolveAvailableRuntimeId('claude-code', false)).toBeUndefined()
    expect(resolveAvailableRuntimeId('codex', false)).toBeUndefined()
  })

  it('renders and accessibly announces the current runtime', () => {
    Platform.isDesktop = true

    const html = renderToStaticMarkup(
      <RuntimeSelector currentRuntimeId="codex" onRuntimeChange={() => {}} />,
    )

    expect(html).toContain('data-runtime-id="codex"')
    expect(html).toContain('aria-label="Chat backend: Codex"')
    expect(html).toContain('>Codex<')
    expect(html).toContain('>CLI<')
  })

  it('renders no runtime entry on mobile even with a stale CLI selection', () => {
    Platform.isDesktop = false

    const html = renderToStaticMarkup(
      <RuntimeSelector
        currentRuntimeId="claude-code"
        onRuntimeChange={() => {}}
      />,
    )

    expect(html).toBe('')
    expect(html).not.toContain('yolo-runtime-selector')
    expect(html).not.toContain('CLI')
  })
})
