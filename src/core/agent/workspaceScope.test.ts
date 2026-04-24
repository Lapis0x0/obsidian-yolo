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

  it('extracts array path from fs_read.paths', () => {
    expect(
      collectToolCallPaths('fs_read', { paths: ['a.md', 'b.md'] }),
    ).toEqual(['a.md', 'b.md'])
  })

  it('extracts oldPath + newPath for fs_move top-level', () => {
    expect(
      collectToolCallPaths('fs_move', {
        oldPath: 'a.md',
        newPath: 'b.md',
      }),
    ).toEqual(['a.md', 'b.md'])
  })

  it('extracts paths from batch items[] for fs_create_file', () => {
    expect(
      collectToolCallPaths('fs_create_file', {
        items: [
          { path: 'a.md', content: '' },
          { path: 'b.md', content: '' },
        ],
      }),
    ).toEqual(['a.md', 'b.md'])
  })

  it('extracts oldPath + newPath from batch items[] for fs_move', () => {
    expect(
      collectToolCallPaths('fs_move', {
        items: [
          { oldPath: 'a.md', newPath: 'b.md' },
          { oldPath: 'c.md', newPath: 'd.md' },
        ],
      }),
    ).toEqual(['a.md', 'b.md', 'c.md', 'd.md'])
  })

  it('ignores empty strings and non-string values', () => {
    expect(
      collectToolCallPaths('fs_list', { path: '  ' }),
    ).toEqual([])
    expect(
      collectToolCallPaths('fs_read', { paths: ['a.md', 42, null] }),
    ).toEqual(['a.md'])
  })

  it('skips non-object items in batch', () => {
    expect(
      collectToolCallPaths('fs_delete_file', {
        items: [null, 'string', { path: 'a.md' }],
      }),
    ).toEqual(['a.md'])
  })
})

describe('findPathOutsideScope', () => {
  it('returns null when scope is disabled', () => {
    expect(
      findPathOutsideScope(
        'fs_read',
        { paths: ['secret/a.md'] },
        scope({ enabled: false, include: ['allowed'] }),
      ),
    ).toBeNull()
  })

  it('returns the first offending path for array args', () => {
    expect(
      findPathOutsideScope(
        'fs_read',
        { paths: ['allowed/a.md', 'secret/b.md', 'allowed/c.md'] },
        scope({ include: ['allowed'] }),
      ),
    ).toBe('secret/b.md')
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

  it('catches out-of-scope batch items for fs_delete_file', () => {
    expect(
      findPathOutsideScope(
        'fs_delete_file',
        { items: [{ path: 'allowed/a.md' }, { path: 'secret/b.md' }] },
        scope({ include: ['allowed'] }),
      ),
    ).toBe('secret/b.md')
  })

  it('catches out-of-scope batch fs_move items', () => {
    expect(
      findPathOutsideScope(
        'fs_move',
        {
          items: [
            { oldPath: 'allowed/a.md', newPath: 'allowed/b.md' },
            { oldPath: 'allowed/c.md', newPath: 'secret/c.md' },
          ],
        },
        scope({ include: ['allowed'] }),
      ),
    ).toBe('secret/c.md')
  })

  it('returns null when all paths are allowed', () => {
    expect(
      findPathOutsideScope(
        'fs_move',
        {
          items: [
            { oldPath: 'allowed/a.md', newPath: 'allowed/b.md' },
            { oldPath: 'allowed/c.md', newPath: 'allowed/d.md' },
          ],
        },
        scope({ include: ['allowed'] }),
      ),
    ).toBeNull()
  })
})
