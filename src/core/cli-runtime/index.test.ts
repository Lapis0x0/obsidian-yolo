import { readFileSync } from 'node:fs'

describe('CLI runtime entry point', () => {
  it('does not statically re-export desktop-only runtime implementations', () => {
    const source = readFileSync('src/core/cli-runtime/index.ts', 'utf8')

    expect(source).not.toMatch(
      /export \* from '\.\/(claude|codex|conversation-controller|coordinator|model-catalog|session-index|session-service|vault-session-index-store)'/u,
    )
  })
})
