import { AssistantWorkspaceScope } from '../../types/assistant.types'

import {
  buildRagScopeForWorkspace,
  collectToolCallPaths,
  describePathDenial,
  findPathOutsideScope,
  isPathAllowedByScope,
  isWorkspaceScopeActive,
  resolvePathVisibility,
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

describe('resolvePathVisibility', () => {
  const settings = { yolo: { baseDir: 'YOLO' } }

  it('is visible when no scope or settings constrain the path', () => {
    expect(resolvePathVisibility('Notes/a.md', {})).toBe('visible')
  })

  it('is hidden for a path inside the YOLO user-data root, regardless of scope', () => {
    expect(
      resolvePathVisibility('YOLO/data/chats/v1_abc.json', { settings }),
    ).toBe('hidden')
    // Hidden wins even when scope would otherwise allow the path.
    expect(
      resolvePathVisibility('YOLO/data/chats/v1_abc.json', {
        settings,
        scope: scope({ include: ['YOLO'] }),
      }),
    ).toBe('hidden')
    // ...and even when scope is disabled entirely.
    expect(
      resolvePathVisibility('YOLO/data/chats/v1_abc.json', {
        settings,
        scope: scope({ enabled: false, include: ['YOLO'] }),
      }),
    ).toBe('hidden')
  })

  it('is out-of-scope for a real path excluded by workspace scope', () => {
    expect(
      resolvePathVisibility('Private/secret.md', {
        scope: scope({ include: ['Notes'] }),
      }),
    ).toBe('out-of-scope')
  })

  it('is visible for a path allowed by scope', () => {
    expect(
      resolvePathVisibility('Notes/a.md', {
        scope: scope({ include: ['Notes'] }),
      }),
    ).toBe('visible')
  })

  it('is visible when scope excludes the path but a skill exemption covers it', () => {
    const exemptPaths = new Set(['Skills/pkg/SKILL.md'])
    expect(
      resolvePathVisibility('Skills/pkg/reference.md', {
        scope: scope({ include: ['Notes'] }),
        exemptPaths,
      }),
    ).toBe('visible')
  })

  it('does not let a skill exemption override the hidden check', () => {
    const exemptPaths = new Set(['YOLO/data/SKILL.md'])
    expect(
      resolvePathVisibility('YOLO/data/chats/v1_abc.json', {
        settings,
        scope: scope({ include: ['Notes'] }),
        exemptPaths,
      }),
    ).toBe('hidden')
  })
})

describe('describePathDenial', () => {
  it('disguises a hidden path as a genuine miss, defaulting to "file"', () => {
    expect(describePathDenial('hidden', 'YOLO/data/chats/v1_abc.json')).toBe(
      'File not found: YOLO/data/chats/v1_abc.json',
    )
  })

  it('disguises a hidden folder using the folder wording when asked', () => {
    expect(describePathDenial('hidden', 'YOLO/data', 'folder')).toBe(
      'Folder not found: YOLO/data',
    )
  })

  it('explicitly denies an out-of-scope path rather than disguising it as missing', () => {
    expect(describePathDenial('out-of-scope', 'Private/secret.md')).toBe(
      'Path "Private/secret.md" is outside this agent\'s workspace scope.',
    )
  })

  it('echoes exactly the string it was given, never a resolved path (issue #577)', () => {
    // The caller is responsible for passing the agent's raw, unresolved
    // input (e.g. a wikilink) rather than whatever it resolved to — this
    // just pins that the function itself performs no substitution.
    expect(describePathDenial('out-of-scope', '[[Secret]]')).toBe(
      'Path "[[Secret]]" is outside this agent\'s workspace scope.',
    )
    expect(describePathDenial('hidden', '[[Secret]]')).toBe(
      'File not found: [[Secret]]',
    )
  })
})

describe('buildRagScopeForWorkspace', () => {
  const settings = { yolo: { baseDir: 'YOLO' } }
  const hiddenRoot = 'YOLO/data'

  it('excludes only the hidden root when there is no pathScope or workspace', () => {
    expect(buildRagScopeForWorkspace({ settings })).toEqual({
      scope: { files: [], folders: [], exclude: [hiddenRoot] },
    })
  })

  it('passes pathScope through unchanged when there is no workspace include', () => {
    expect(
      buildRagScopeForWorkspace({
        pathScope: { files: [], folders: ['Projects'] },
        settings,
      }),
    ).toEqual({
      scope: { files: [], folders: ['Projects'], exclude: [hiddenRoot] },
    })
  })

  it('passes workspace.include through unchanged when there is no pathScope', () => {
    expect(
      buildRagScopeForWorkspace({
        workspace: scope({ include: ['Notes'], exclude: ['Notes/Private'] }),
        settings,
      }),
    ).toEqual({
      scope: {
        files: ['Notes'],
        folders: ['Notes'],
        exclude: ['Notes/Private', hiddenRoot],
      },
    })
  })

  it('keeps the deeper root when pathScope and workspace.include nest', () => {
    // pathScope narrows to a folder the caller already resolved
    // (`vault_search`'s `path` argument); workspace.include is broader, so
    // the intersection is the deeper (pathScope) folder.
    expect(
      buildRagScopeForWorkspace({
        pathScope: { files: [], folders: ['Projects/Client'] },
        workspace: scope({ include: ['Projects'] }),
        settings,
      }),
    ).toEqual({
      scope: {
        files: [],
        folders: ['Projects/Client'],
        exclude: [hiddenRoot],
      },
    })

    // The other way around: workspace.include is the deeper root. A
    // workspace rule is ambiguous (it may denote a file or a folder), so it
    // decomposes into both an exact-match and a subtree reading; the
    // subtree reading nests inside pathScope's folder as before, and here
    // the exact reading *also* survives because "Projects/Client" itself is
    // a strict descendant of "Projects" — i.e. pathScope's folder rule
    // already covers that literal path too. Both are harmless: no real
    // vector row is ever literally named "Projects/Client" (paths always
    // carry a file extension), so the `files` entry is a no-op in practice.
    expect(
      buildRagScopeForWorkspace({
        pathScope: { files: [], folders: ['Projects'] },
        workspace: scope({ include: ['Projects/Client'] }),
        settings,
      }),
    ).toEqual({
      scope: {
        files: ['Projects/Client'],
        folders: ['Projects/Client'],
        exclude: [hiddenRoot],
      },
    })
  })

  it('keeps a single file when it falls inside the other side’s folder', () => {
    expect(
      buildRagScopeForWorkspace({
        pathScope: { files: ['Projects/a.md'], folders: [] },
        workspace: scope({ include: ['Projects'] }),
        settings,
      }),
    ).toEqual({
      scope: { files: ['Projects/a.md'], folders: [], exclude: [hiddenRoot] },
    })
  })

  it('returns empty when pathScope and workspace.include share no path', () => {
    expect(
      buildRagScopeForWorkspace({
        pathScope: { files: [], folders: ['Private'] },
        workspace: scope({ include: ['Notes'] }),
        settings,
      }),
    ).toEqual({ empty: true })
  })

  it('does not rescue an otherwise-empty intersection with an exempt path outside the explicit pathScope', () => {
    // The exempt path lives under YOLO/skills, not under pathScope's
    // "Private" folder, so it must not escape the caller's explicit path
    // restriction even though it would otherwise be exempt from
    // workspace.include (Codex finding 1.6).
    const exemptPaths = new Set(['YOLO/skills/demo/SKILL.md'])
    expect(
      buildRagScopeForWorkspace({
        pathScope: { files: [], folders: ['Private'] },
        workspace: scope({ include: ['Notes'] }),
        settings,
        exemptPaths,
      }),
    ).toEqual({ empty: true })
  })

  it('rescues an otherwise-empty intersection only when the exempt path falls inside the explicit pathScope', () => {
    const exemptPaths = new Set(['Private/skills/demo/SKILL.md'])
    expect(
      buildRagScopeForWorkspace({
        pathScope: { files: [], folders: ['Private'] },
        workspace: scope({ include: ['Notes'] }),
        settings,
        exemptPaths,
      }),
    ).toEqual({
      scope: {
        files: ['Private/skills/demo/SKILL.md'],
        folders: [],
        exclude: [hiddenRoot],
      },
    })
  })

  it('merges exempt paths into files whenever workspace.include is non-empty', () => {
    const exemptPaths = new Set(['YOLO/skills/demo/SKILL.md'])
    expect(
      buildRagScopeForWorkspace({
        workspace: scope({ include: ['Notes'] }),
        settings,
        exemptPaths,
      }),
    ).toEqual({
      scope: {
        files: ['Notes', 'YOLO/skills/demo/SKILL.md'],
        folders: ['Notes'],
        exclude: [hiddenRoot],
      },
    })
  })

  it('does not add exempt paths when workspace.include is empty (already unrestricted)', () => {
    const exemptPaths = new Set(['YOLO/skills/demo/SKILL.md'])
    expect(
      buildRagScopeForWorkspace({
        workspace: scope({ exclude: ['Private'] }),
        settings,
        exemptPaths,
      }),
    ).toEqual({
      scope: { files: [], folders: [], exclude: ['Private', hiddenRoot] },
    })
  })

  it('contributes only the hidden root for a disabled workspace, ignoring its rules', () => {
    expect(
      buildRagScopeForWorkspace({
        workspace: scope({
          enabled: false,
          include: ['Notes'],
          exclude: ['Private'],
        }),
        settings,
      }),
    ).toEqual({
      scope: { files: [], folders: [], exclude: [hiddenRoot] },
    })
  })

  it('treats a root include rule ("/") as no include restriction at all', () => {
    // Normalizes to '' — matchesRule's own root semantics say '' matches
    // every path, so the whole include list must behave as unrestricted
    // rather than literally intersecting against a rule nothing can match
    // (Codex finding 1.7).
    expect(
      buildRagScopeForWorkspace({
        workspace: scope({ include: ['/'] }),
        settings,
      }),
    ).toEqual({
      scope: { files: [], folders: [], exclude: [hiddenRoot] },
    })

    // Still unrestricted even mixed with other include rules, and even
    // against an explicit pathScope — '/' alone already matches everything
    // those other rules would.
    expect(
      buildRagScopeForWorkspace({
        pathScope: { files: [], folders: ['Projects'] },
        workspace: scope({ include: ['/', 'Notes'] }),
        settings,
      }),
    ).toEqual({
      scope: { files: [], folders: ['Projects'], exclude: [hiddenRoot] },
    })
  })

  it('treats a root exclude rule ("/") as excluding everything', () => {
    expect(
      buildRagScopeForWorkspace({
        workspace: scope({ exclude: ['/'] }),
        settings,
      }),
    ).toEqual({ empty: true })

    // Even a matching include can't rescue it — exclude wins.
    expect(
      buildRagScopeForWorkspace({
        workspace: scope({ include: ['Notes'], exclude: ['/'] }),
        settings,
      }),
    ).toEqual({ empty: true })
  })
})
