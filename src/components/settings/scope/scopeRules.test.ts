import {
  ScopeRule,
  applyRule,
  buildFolderFileCounts,
  describeScope,
  effectiveState,
  estimateFiles,
  includeScopeLabels,
  ruleDisabledReason,
  rulesFromWorkspaceScope,
  workspaceScopeFromRules,
} from './scopeRules'

const include = (path: string): ScopeRule => ({ path, kind: 'include' })
const exclude = (path: string): ScopeRule => ({ path, kind: 'exclude' })

const asFolders = () => 'folder' as const

describe('effectiveState', () => {
  it('includes everything when there are no rules', () => {
    expect(effectiveState('Work/Notes', [])).toEqual({
      state: 'include',
      source: null,
    })
  })

  it('flips the default to exclude as soon as one include rule exists', () => {
    const rules = [include('Work')]
    expect(effectiveState('Work', rules)).toEqual({
      state: 'include',
      source: 'Work',
    })
    expect(effectiveState('Work/Weekly', rules)).toEqual({
      state: 'include',
      source: 'Work',
    })
    expect(effectiveState('Diary', rules)).toEqual({
      state: 'exclude',
      source: null,
    })
  })

  it('lets exclude win over an include anywhere on the ancestor chain', () => {
    const rules = [include('Work'), exclude('Work/Weekly')]
    expect(effectiveState('Work/Weekly/2026-W01.md', rules)).toEqual({
      state: 'exclude',
      source: 'Work/Weekly',
    })
  })

  it('reports the nearest excluding ancestor as the source', () => {
    const rules = [exclude('a'), exclude('a/b')]
    expect(effectiveState('a/b/c', rules)).toEqual({
      state: 'exclude',
      source: 'a/b',
    })
  })

  it('treats a root rule as covering every path', () => {
    expect(effectiveState('anything/at/all', [exclude('')])).toEqual({
      state: 'exclude',
      source: '',
    })
  })

  it('normalizes leading and trailing slashes on both sides', () => {
    expect(
      effectiveState('/Work/Notes/', [{ path: '/Work/', kind: 'exclude' }]),
    ).toEqual({ state: 'exclude', source: 'Work' })
  })
})

describe('ruleDisabledReason', () => {
  it('allows both marks when no ancestor carries a rule', () => {
    expect(ruleDisabledReason('Work', 'include', [])).toBeNull()
    expect(ruleDisabledReason('Work', 'exclude', [])).toBeNull()
  })

  it('blocks both marks under an excluded ancestor', () => {
    const rules = [exclude('Work')]
    expect(ruleDisabledReason('Work/Weekly', 'include', rules)).toEqual({
      kind: 'excludedAncestor',
      ancestor: 'Work',
    })
    expect(ruleDisabledReason('Work/Weekly', 'exclude', rules)).toEqual({
      kind: 'excludedAncestor',
      ancestor: 'Work',
    })
  })

  it('blocks only the redundant include under an included ancestor', () => {
    const rules = [include('Work')]
    expect(ruleDisabledReason('Work/Weekly', 'include', rules)).toEqual({
      kind: 'includedAncestor',
      ancestor: 'Work',
    })
    expect(ruleDisabledReason('Work/Weekly', 'exclude', rules)).toBeNull()
  })

  it('never blocks a mark on the path that carries the rule itself', () => {
    expect(ruleDisabledReason('Work', 'include', [include('Work')])).toBeNull()
    expect(ruleDisabledReason('Work', 'exclude', [exclude('Work')])).toBeNull()
  })
})

describe('applyRule', () => {
  it('clears a mark without touching other rules', () => {
    const rules = [include('Work'), exclude('Diary')]
    expect(applyRule(rules, 'Work', null)).toEqual([exclude('Diary')])
  })

  it('replaces a mark on the same path', () => {
    expect(applyRule([include('Work')], 'Work', 'exclude')).toEqual([
      exclude('Work'),
    ])
  })

  it('drops every descendant rule when a parent is excluded', () => {
    const rules = [
      include('Work/Weekly'),
      exclude('Work/Drafts'),
      exclude('Diary'),
    ]
    expect(applyRule(rules, 'Work', 'exclude')).toEqual([
      exclude('Diary'),
      exclude('Work'),
    ])
  })

  it('drops descendant includes but keeps descendant excludes when a parent is included', () => {
    const rules = [include('Work/Weekly'), exclude('Work/Drafts')]
    expect(applyRule(rules, 'Work', 'include')).toEqual([
      exclude('Work/Drafts'),
      include('Work'),
    ])
  })

  it('refuses a mark the disabled reason rejects', () => {
    const excluded = [exclude('Work')]
    expect(applyRule(excluded, 'Work/Weekly', 'include')).toEqual(excluded)
    expect(applyRule(excluded, 'Work/Weekly', 'exclude')).toEqual(excluded)
    const included = [include('Work')]
    expect(applyRule(included, 'Work/Weekly', 'include')).toEqual(included)
  })

  it('does not treat a sibling with a shared name prefix as a descendant', () => {
    const rules = [include('Workshop')]
    expect(applyRule(rules, 'Work', 'exclude')).toEqual([
      include('Workshop'),
      exclude('Work'),
    ])
  })

  it('absorbs everything when the root is excluded', () => {
    const rules = [include('Work'), exclude('Diary')]
    expect(applyRule(rules, '', 'exclude')).toEqual([exclude('')])
  })
})

describe('describeScope', () => {
  const kindOf = (path: string) => (path.endsWith('.md') ? 'file' : 'folder')

  it('counts every exclude when there is no include rule', () => {
    const description = describeScope(
      [exclude('YOLO'), exclude('Diary')],
      asFolders,
    )
    expect(description.hasInclude).toBe(false)
    expect(description.include.total).toBe(0)
    expect(description.exclude).toEqual({ folders: 2, files: 0, total: 2 })
  })

  it('counts only excludes nested inside an include rule once includes exist', () => {
    const description = describeScope(
      [include('Work'), exclude('Work/Weekly'), exclude('YOLO')],
      asFolders,
    )
    expect(description.hasInclude).toBe(true)
    expect(description.include).toEqual({ folders: 1, files: 0, total: 1 })
    expect(description.exclude).toEqual({ folders: 1, files: 0, total: 1 })
  })

  it('separates folder and file counts', () => {
    const description = describeScope(
      [include('Work'), include('Diary/2026-08-23.md')],
      kindOf,
    )
    expect(description.include).toEqual({ folders: 1, files: 1, total: 2 })
  })
})

describe('includeScopeLabels', () => {
  const kindOf = (path: string) => (path.endsWith('.md') ? 'file' : 'folder')

  it('uses the last path segment and keeps a trailing slash on folders', () => {
    expect(
      includeScopeLabels(
        [include('工作'), include('项目/进行中'), include('Inbox/todo.md')],
        kindOf,
      ),
    ).toEqual(['工作/', '进行中/', 'todo.md'])
  })

  it('skips include of the vault root, which has no display name', () => {
    expect(includeScopeLabels([include('')], asFolders)).toEqual([])
  })
})

describe('estimateFiles', () => {
  const files = [
    'Work/OKR.md',
    'Work/Weekly/2026-W01.md',
    'Diary/2026-08-23.md',
    'YOLO/chats/a.md',
  ]

  it('matches everything with no rules', () => {
    expect(estimateFiles(files, [])).toEqual({ matched: 4, total: 4 })
  })

  it('applies exclude first, then include', () => {
    expect(
      estimateFiles(files, [include('Work'), exclude('Work/Weekly')]),
    ).toEqual({ matched: 1, total: 4 })
  })

  it('excludes a subtree while keeping the rest of the vault', () => {
    expect(estimateFiles(files, [exclude('YOLO')])).toEqual({
      matched: 3,
      total: 4,
    })
  })
})

describe('buildFolderFileCounts', () => {
  it('counts every file into each ancestor folder including the root', () => {
    const counts = buildFolderFileCounts([
      'Work/OKR.md',
      'Work/Weekly/2026-W01.md',
      'Diary/2026-08-23.md',
    ])
    expect(counts.get('')).toBe(3)
    expect(counts.get('Work')).toBe(2)
    expect(counts.get('Work/Weekly')).toBe(1)
    expect(counts.get('Diary')).toBe(1)
    expect(counts.get('Missing')).toBeUndefined()
  })
})

describe('workspace scope conversion', () => {
  it('round-trips include and exclude lists', () => {
    const scope = {
      include: ['Work', '/Diary/'],
      exclude: ['Work/Weekly'],
    }
    const rules = rulesFromWorkspaceScope(scope)
    expect(rules).toEqual([
      include('Work'),
      include('Diary'),
      exclude('Work/Weekly'),
    ])
    expect(workspaceScopeFromRules(rules)).toEqual({
      include: ['Work', 'Diary'],
      exclude: ['Work/Weekly'],
    })
  })
})
