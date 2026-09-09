import { buildRuntimeModePrompt } from './runtime-mode-prompt'

describe('buildRuntimeModePrompt', () => {
  it('routes Ask to Agent for vault edits and to Max for everything past the vault', () => {
    const prompt = buildRuntimeModePrompt('ask')

    expect(prompt).toContain('You are in Ask mode')
    expect(prompt).toContain('cannot change it')
    expect(prompt).toContain('require Agent mode')
    // Keeps the caveat that stops the model promising something an Agent may
    // not actually have enabled.
    expect(prompt).toContain('depends on its enabled tools')
    expect(prompt).toContain('require Max mode')
  })

  it('states the vault-API boundary in Agent mode and routes past it to Max', () => {
    const prompt = buildRuntimeModePrompt('agent')

    expect(prompt).toContain('You are in Agent mode')
    expect(prompt).toContain('vault-relative')
    expect(prompt).toContain('nothing outside the vault is reachable')
    expect(prompt).toContain('Max mode (desktop-only)')
    // Without this the always-present routing sentence becomes an upsell on
    // ordinary vault work.
    expect(prompt).toContain('Do not raise Max for work Agent can already do')
  })

  it('names Max as desktop-only instead of emitting a mobile variant', () => {
    // One string per mode, on every device: the parenthetical is true
    // everywhere, so there is no `Platform` branch to keep in sync.
    expect(buildRuntimeModePrompt('ask')).toContain('desktop-only')
    expect(buildRuntimeModePrompt('agent')).toContain('desktop-only')
  })

  it('says nothing in Max mode', () => {
    // Nowhere to route, and `buildMaxEnvironmentPrompt` already states Max's
    // reach in concrete terms (cwd, platform, shell, out-of-vault approval).
    expect(buildRuntimeModePrompt('max')).toBeUndefined()
  })

  it('never reports which toolsets are missing', () => {
    // The gap report is gone on purpose — "absent from the tool list" cannot
    // tell a user-disabled capability from one `isAvailable` rules out
    // (mobile terminal, `bash` without its runtime component), so every
    // remedy it offered was a guess. See this module's doc comment.
    for (const mode of ['ask', 'agent', 'max'] as const) {
      const prompt = buildRuntimeModePrompt(mode) ?? ''
      expect(prompt).not.toMatch(
        /unavailable|not enabled|disabled in settings/i,
      )
      expect(prompt).not.toMatch(/\bfs_(read|edit|write)\b|\bbash\b/)
    }
  })
})
