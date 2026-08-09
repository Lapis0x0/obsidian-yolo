import { AssistantWorkspaceScope } from '../../types/assistant.types'

import {
  collectToolCallPaths,
  findPathOutsideScope,
  isPathAllowedByScope,
  isWorkspaceScopeActive,
} from './workspaceScope'

const scope = (
  override: Partial<AssistantWorkspaceScope>,
): AssistantWorkspaceScope => ({
  enabled: true,
  include: [],
  exclude: [],
  ...override,
})

describe('isPathAllowedByScope', () => {
  it('allows everything when scope is undefined or disabled', () => {
    expect(isPathAllowedByScope('foo/bar.md', undefined)).toBe(true)
    expect(
      isPathAllowedByScope(
        'foo/bar.md',
        scope({ enabled: false, include: ['allowed/'] }),
      ),
    ).toBe(true)
  })

  it('whitelists only include paths (exact + prefix) when enabled', () => {
    const s = scope({ include: ['Projects'] })
    expect(isPathAllowedByScope('Projects', s)).toBe(true)
    expect(isPathAllowedByScope('Projects/a.md', s)).toBe(true)
    expect(isPathAllowedByScope('ProjectsX/a.md', s)).toBe(false)
    expect(isPathAllowedByScope('Notes/a.md', s)).toBe(false)
  })

  it('treats empty include as "allow everything not excluded" (blacklist mode)', () => {
    const s = scope({ exclude: ['Private'] })
    expect(isPathAllowedByScope('Notes/a.md', s)).toBe(true)
    expect(isPathAllowedByScope('Private/a.md', s)).toBe(false)
  })

  it('applies exclude with higher priority than include', () => {
    const s = scope({
      include: ['Projects'],
      exclude: ['Projects/Private'],
    })
    expect(isPathAllowedByScope('Projects/public.md', s)).toBe(true)
    expect(isPathAllowedByScope('Projects/Private/secret.md', s)).toBe(false)
  })

  it('normalizes leading and trailing slashes on both path and rule', () => {
    const s = scope({ include: ['/Projects/'] })
    expect(isPathAllowedByScope('/Projects/a.md', s)).toBe(true)
    expect(isPathAllowedByScope('Projects', s)).toBe(true)
  })
})

describe('isWorkspaceScopeActive', () => {
  it('returns false when disabled or empty', () => {
    expect(isWorkspaceScopeActive(undefined)).toBe(false)
    expect(isWorkspaceScopeActive(scope({ enabled: false }))).toBe(false)
    expect(isWorkspaceScopeActive(scope({}))).toBe(false)
  })

  it('returns true when enabled with any rule', () => {
    expect(isWorkspaceScopeActive(scope({ include: ['a'] }))).toBe(true)
    expect(isWorkspaceScopeActive(scope({ exclude: ['b'] }))).toBe(true)
  })
})

describe('collectToolCallPaths', () => {
  it('returns empty array for unknown tools', () => {
    expect(collectToolCallPaths('unknown', { path: 'x' })).toEqual([])
  })

  it('extracts single path from top-level string args', () => {
    expect(collectToolCallPaths('fs_list', { path: 'a/b' })).toEqual(['a/b'])
    expect(collectToolCallPaths('fs_edit', { path: 'a/b.md' })).toEqual([
      'a/b.md',
    ])
  })

  it('returns empty for fs_read (its paths may be wikilinks, not literal vault paths — scope is enforced per-resolved-file inside its own read loop instead, see localFileTools.ts)', () => {
    expect(
      collectToolCallPaths('fs_read', { paths: ['a.md', 'b.md'] }),
    ).toEqual([])
  })

  it('extracts oldPath + newPath for fs_move top-level', () => {
    expect(
      collectToolCallPaths('fs_move', {
        oldPath: 'a.md',
        newPath: 'b.md',
      }),
    ).toEqual(['a.md', 'b.md'])
  })

  it('extracts path for fs_write', () => {
    expect(
      collectToolCallPaths('fs_write', { path: 'a.md', content: '' }),
    ).toEqual(['a.md'])
  })

  it('extracts path for fs_delete', () => {
    expect(
      collectToolCallPaths('fs_delete', { path: 'a.md', recursive: true }),
    ).toEqual(['a.md'])
  })

  it('ignores empty strings and non-string values', () => {
    expect(collectToolCallPaths('fs_list', { path: '  ' })).toEqual([])
  })
})

describe('findPathOutsideScope', () => {
  it('returns null when scope is disabled', () => {
    expect(
      findPathOutsideScope(
        'fs_edit',
        { path: 'secret/a.md' },
        scope({ enabled: false, include: ['allowed'] }),
      ),
    ).toBeNull()
  })

  it('is a no-op for fs_read regardless of scope — its paths may be wikilinks, resolved and scope-checked per-file inside fs_read itself (see localFileTools.ts)', () => {
    expect(
      findPathOutsideScope(
        'fs_read',
        { paths: ['secret/a.md'] },
        scope({ include: ['allowed'] }),
      ),
    ).toBeNull()
  })

  it('catches out-of-scope oldPath in fs_move', () => {
    expect(
      findPathOutsideScope(
        'fs_move',
        { oldPath: 'allowed/a.md', newPath: 'secret/a.md' },
        scope({ include: ['allowed'] }),
      ),
    ).toBe('secret/a.md')
  })

  it('catches out-of-scope path for fs_delete', () => {
    expect(
      findPathOutsideScope(
        'fs_delete',
        { path: 'secret/b.md' },
        scope({ include: ['allowed'] }),
      ),
    ).toBe('secret/b.md')
  })

  it('returns null when all paths are allowed', () => {
    expect(
      findPathOutsideScope(
        'fs_move',
        { oldPath: 'allowed/a.md', newPath: 'allowed/b.md' },
        scope({ include: ['allowed'] }),
      ),
    ).toBeNull()
  })

  it('exempts listed skill paths from workspace scope', () => {
    const exemptPaths = new Set(['YOLO/skills/demo/SKILL.md'])
    expect(
      findPathOutsideScope(
        'fs_edit',
        { path: 'YOLO/skills/demo/SKILL.md' },
        scope({ include: ['Notes'] }),
        { exemptPaths },
      ),
    ).toBeNull()
    expect(
      findPathOutsideScope(
        'fs_edit',
        { path: 'YOLO/skills/demo/references/guide.md' },
        scope({ include: ['Notes'] }),
        { exemptPaths },
      ),
    ).toBeNull()
    expect(
      findPathOutsideScope(
        'fs_edit',
        { path: 'YOLO/skills/other/SKILL.md' },
        scope({ include: ['Notes'] }),
        { exemptPaths },
      ),
    ).toBe('YOLO/skills/other/SKILL.md')
  })

  it('exempts builtin skill paths from workspace scope', () => {
    const exemptPaths = new Set(['builtin://skills/skill-creator.md'])
    expect(
      findPathOutsideScope(
        'fs_edit',
        { path: 'builtin://skills/skill-creator.md' },
        scope({ include: ['Notes'] }),
        { exemptPaths },
      ),
    ).toBeNull()
  })

  it('exempts browser:// paths from workspace scope', () => {
    expect(
      findPathOutsideScope(
        'fs_edit',
        { path: 'browser://page_ab12cd34_ef56gh78' },
        scope({ include: ['Notes'] }),
      ),
    ).toBeNull()
  })
})
