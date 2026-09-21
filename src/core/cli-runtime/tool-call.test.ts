import { toCliEditSummaryPath } from './tool-call'

describe('toCliEditSummaryPath', () => {
  it('records a file inside the vault by its vault-relative path', () => {
    expect(toCliEditSummaryPath('/vault/a/b.md', '/vault/')).toBe('a/b.md')
    expect(toCliEditSummaryPath('C:\\vault\\a.md', 'C:\\vault')).toBe('a.md')
  })

  it('keeps paths outside the vault absolute', () => {
    expect(toCliEditSummaryPath('/other/a.md', '/vault')).toBe('/other/a.md')
  })

  it('leaves a path already relative to the agent cwd as it is', () => {
    expect(toCliEditSummaryPath('notes/a.md', '/vault')).toBe('notes/a.md')
    expect(toCliEditSummaryPath('/vault/a.md', undefined)).toBe('/vault/a.md')
  })
})
