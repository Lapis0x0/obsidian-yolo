/* eslint-disable import/no-nodejs-modules -- test inspects the source boundary without loading desktop runtime modules */
import { readFileSync } from 'node:fs'
/* eslint-enable import/no-nodejs-modules */

describe('CLI runtime entry point', () => {
  it('does not statically re-export desktop-only runtime implementations', () => {
    const source = readFileSync('src/core/cli-runtime/index.ts', 'utf8')

    expect(source).not.toMatch(
      /export \* from '\.\/(claude|codex|conversation-controller|coordinator|model-catalog|session-index|session-service|vault-session-index-store)'/u,
    )
  })
})
