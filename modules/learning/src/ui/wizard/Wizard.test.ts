import { mergeStagedReferences } from './Wizard'

describe('mergeStagedReferences', () => {
  it('replaces a staged path while preserving unrelated file order', () => {
    expect(
      mergeStagedReferences(
        [
          { name: 'old.pdf', vaultPath: 'staging/shared.pdf' },
          { name: 'notes.md', vaultPath: 'staging/notes.md' },
        ],
        [{ name: 'new.pdf', vaultPath: 'staging/shared.pdf' }],
      ),
    ).toEqual([
      { name: 'notes.md', vaultPath: 'staging/notes.md' },
      { name: 'new.pdf', vaultPath: 'staging/shared.pdf' },
    ])
  })
})
