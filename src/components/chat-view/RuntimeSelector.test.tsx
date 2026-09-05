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
          'sidebar.runtimeSelector.ompLabel': 'omp',
          'sidebar.runtimeSelector.ompDescription': 'Oh My Pi on this device',
          'sidebar.runtimeSelector.grokLabel': 'Grok',
          'sidebar.runtimeSelector.grokDescription': 'Grok on this device',
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
jest.mock('../../assets/provider-icons/omp.svg', () => ({
  __esModule: true,
  default: 'omp-logo',
}))
jest.mock('../../assets/provider-icons/xai.svg', () => ({
  __esModule: true,
  default: 'xai-logo',
}))

import { Platform } from 'obsidian'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  RuntimeSelector,
  getRuntimeSelectorRows,
  resolveRuntimeSelectorRowState,
} from './RuntimeSelector'

const selectorRow = (primaryId: string) => {
  const row = getRuntimeSelectorRows(true).find(
    (candidate) => candidate.primary.id === primaryId,
  )
  if (!row) throw new Error(`no selector row for ${primaryId}`)
  return row
}

describe('RuntimeSelector', () => {
  const originalIsDesktop = Platform.isDesktop

  afterEach(() => {
    Platform.isDesktop = originalIsDesktop
  })

  it('exposes no provider without desktop capability', () => {
    expect(getRuntimeSelectorRows(false)).toEqual([])
  })

  it('folds omp into the pi row instead of giving it a row of its own', () => {
    expect(getRuntimeSelectorRows(true).map((row) => row.primary.id)).toEqual([
      'claude-code',
      'codex',
      'hermes',
      'pi',
      'grok',
    ])
    expect(selectorRow('pi').variants.map((variant) => variant.id)).toEqual([
      'omp',
    ])
  })

  it('checks the pi row with its omp switch on while omp is the runtime', () => {
    const state = resolveRuntimeSelectorRowState(selectorRow('pi'), 'omp')

    expect(state.isSelected).toBe(true)
    // Clicking the row body follows the switch — it re-selects omp, not pi.
    expect(state.rowTargetId).toBe('omp')
    expect(state.variants).toEqual([
      expect.objectContaining({ isActive: true, toggleTargetId: 'pi' }),
    ])
  })

  it('checks the pi row with its omp switch off while pi is the runtime', () => {
    const state = resolveRuntimeSelectorRowState(selectorRow('pi'), 'pi')

    expect(state.isSelected).toBe(true)
    expect(state.rowTargetId).toBe('pi')
    expect(state.variants).toEqual([
      expect.objectContaining({ isActive: false, toggleTargetId: 'omp' }),
    ])
  })

  it('shows the switch off — with no memory of the last family member — while another runtime is current', () => {
    const state = resolveRuntimeSelectorRowState(selectorRow('pi'), 'codex')

    expect(state.isSelected).toBe(false)
    expect(state.rowTargetId).toBe('pi')
    expect(state.variants).toEqual([
      expect.objectContaining({ isActive: false, toggleTargetId: 'omp' }),
    ])
  })

  it('leaves a row without variants nothing to switch between', () => {
    const state = resolveRuntimeSelectorRowState(selectorRow('codex'), 'codex')

    expect(state.variants).toEqual([])
    expect(state.rowTargetId).toBe('codex')
    expect(state.isSelected).toBe(true)
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

  it('renders Grok with the xAI brand asset', () => {
    Platform.isDesktop = true

    const html = renderToStaticMarkup(
      <RuntimeSelector currentRuntimeId="grok" onRuntimeChange={() => {}} />,
    )

    expect(html).toContain('aria-label="CLI provider: Grok"')
    expect(html).toContain('src="xai-logo"')
    expect(html).toContain('data-provider="xai"')
  })

  // The trigger states which runtime is in play, so a variant never hides
  // behind the runtime it collapses into — only the open menu's rows merge.
  it('names omp on the trigger instead of the pi row it folds into', () => {
    Platform.isDesktop = true

    const html = renderToStaticMarkup(
      <RuntimeSelector currentRuntimeId="omp" onRuntimeChange={() => {}} />,
    )

    expect(html).toContain('data-runtime-id="omp"')
    expect(html).toContain('aria-label="CLI provider: omp"')
    expect(html).toContain('>omp<')
    expect(html).toContain('src="omp-logo"')
    expect(html).toContain('data-provider="omp"')
    expect(html).not.toContain('pi-logo')
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
