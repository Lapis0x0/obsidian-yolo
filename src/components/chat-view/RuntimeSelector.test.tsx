jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          'sidebar.runtimeSelector.accessibleLabel': 'CLI provider: {runtime}',
          'sidebar.runtimeSelector.menuLabel': 'CLI provider',
          'sidebar.runtimeSelector.claudeCodeLabel': 'Claude Code',
          'sidebar.runtimeSelector.claudeCodeDescription':
            'Claude Code on this device',
          'sidebar.runtimeSelector.codexLabel': 'Codex',
          'sidebar.runtimeSelector.codexDescription': 'Codex on this device',
          'sidebar.runtimeSelector.hermesLabel': 'Hermes',
          'sidebar.runtimeSelector.hermesDescription': 'Hermes on this device',
          'sidebar.runtimeSelector.piLabel': 'pi',
          'sidebar.runtimeSelector.piDescription': 'pi on this device',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('../../assets/provider-icons/anthropic.svg', () => ({
  __esModule: true,
  default: 'anthropic-logo',
}))
jest.mock('../../assets/provider-icons/openai.svg', () => ({
  __esModule: true,
  default: 'openai-logo',
}))
jest.mock('../../assets/provider-icons/hermes.svg', () => ({
  __esModule: true,
  default: 'hermes-logo',
}))
jest.mock('../../assets/provider-icons/pi.svg', () => ({
  __esModule: true,
  default: 'pi-logo',
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

  it('exposes only CLI providers on desktop', () => {
    expect(getRuntimeSelectorOptions(true).map((option) => option.id)).toEqual([
      'claude-code',
      'codex',
      'hermes',
      'pi',
    ])
    expect(resolveAvailableRuntimeId('yolo', true)).toBeUndefined()
    expect(resolveAvailableRuntimeId('claude-code', true)).toBe('claude-code')
    expect(resolveAvailableRuntimeId('codex', true)).toBe('codex')
    expect(resolveAvailableRuntimeId('hermes', true)).toBe('hermes')
    expect(resolveAvailableRuntimeId('pi', true)).toBe('pi')
  })

  it('exposes no provider without desktop capability', () => {
    expect(getRuntimeSelectorOptions(false)).toEqual([])
    expect(resolveAvailableRuntimeId('claude-code', false)).toBeUndefined()
    expect(resolveAvailableRuntimeId('codex', false)).toBeUndefined()
  })

  it('renders and accessibly announces the current runtime', () => {
    Platform.isDesktop = true

    const html = renderToStaticMarkup(
      <RuntimeSelector currentRuntimeId="codex" onRuntimeChange={() => {}} />,
    )

    expect(html).toContain('data-runtime-id="codex"')
    expect(html).toContain('aria-label="CLI provider: Codex"')
    expect(html).toContain('>Codex<')
    expect(html).toContain('src="openai-logo"')
    expect(html).toContain('data-provider="openai"')
    expect(html).not.toContain('>CLI<')
    expect(html).not.toContain('YOLO Chat')
  })

  it('uses the Anthropic brand asset for Claude Code', () => {
    Platform.isDesktop = true

    const html = renderToStaticMarkup(
      <RuntimeSelector
        currentRuntimeId="claude-code"
        onRuntimeChange={() => {}}
      />,
    )

    expect(html).toContain('src="anthropic-logo"')
    expect(html).toContain('data-provider="anthropic"')
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
