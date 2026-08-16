import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertReleaseAssetUniqueness,
  deriveReleaseAssetName,
  isSafeArtifactPath,
  isSafeArtifactSegment,
} from './module-release-assets.mjs'

test('a flat path keeps its Release asset name byte-for-byte', () => {
  for (const name of [
    'entry.js',
    'style.css',
    'module-config.json',
    'release-note.md',
    'skill.md',
    'model.q4_0.bin',
    'a_b.md',
  ]) {
    assert.equal(deriveReleaseAssetName(name), name)
  }
})

test('a nested path folds into one flat asset name', () => {
  assert.equal(
    deriveReleaseAssetName('skills/coach/SKILL.md'),
    'skills__coach__SKILL.md',
  )
  assert.equal(
    deriveReleaseAssetName('skills/coach/references/fsrs.md'),
    'skills__coach__references__fsrs.md',
  )
})

test('the fold separates paths a naive separator would collide', () => {
  assert.notEqual(
    deriveReleaseAssetName('a/b-c.md'),
    deriveReleaseAssetName('a-b/c.md'),
  )
  assert.notEqual(
    deriveReleaseAssetName('a/b.c.md'),
    deriveReleaseAssetName('a.b/c.md'),
  )
})

test('the fold is injective across every accepted path shape', () => {
  const segments = ['a', 'b', 'a-b', 'a_b', 'a.b', 'a1']
  const paths = []
  for (const first of segments) {
    paths.push(first)
    for (const second of segments) {
      paths.push(`${first}/${second}`)
      for (const third of segments) paths.push(`${first}/${second}/${third}`)
    }
  }
  const names = new Set(paths.map((value) => deriveReleaseAssetName(value)))
  assert.equal(names.size, paths.length)
})

test('rejects paths the Host would refuse to install', () => {
  for (const value of [
    '',
    '/etc/passwd',
    'C:/windows/system32',
    '../outside.md',
    'skills/../../outside.md',
    'skills//skill.md',
    'skills\\coach.md',
    'skills/./skill.md',
    '.hidden.md',
    'skills/CON.md',
    'skills/trailing.',
    `${'a/'.repeat(17)}skill.md`,
    'skills/cafe\u0301.md',
  ]) {
    assert.equal(isSafeArtifactPath(value), false, value)
    assert.throws(() => deriveReleaseAssetName(value), /safe relative/, value)
  }
})

test('rejects paths the fold cannot represent unambiguously', () => {
  for (const value of [
    'skills__coach.md',
    'skills/coach__notes.md',
    'skills_/coach.md',
    'trailing_',
  ]) {
    // The Host would install these happily — only the flat Release namespace
    // cannot represent them, so they fail at the fold, not the path check.
    assert.equal(isSafeArtifactPath(value), true, value)
    assert.throws(
      () => deriveReleaseAssetName(value),
      /must not contain/,
      value,
    )
  }
})

test('rejects names the download URL cannot carry verbatim', () => {
  // The Host reads the asset name straight out of the URL, never decodes it,
  // and rejects a "%". A "+" is the one character the segment rule admits
  // that `encodeURIComponent` rewrites, so a manifest carrying it would pass
  // the build and both validators and only fail at install.
  for (const value of ['a+b.md', 'skills/a+b.md', 'a+.md']) {
    assert.equal(isSafeArtifactPath(value), false, value)
    assert.throws(() => deriveReleaseAssetName(value), /safe relative/, value)
  }
})

test('rejects a fold longer than the Host accepts as an asset name', () => {
  const long = `${'a'.repeat(130)}/${'b'.repeat(130)}.md`
  // Each segment is installable on its own; only the 255-character asset name
  // the fold produces is not.
  assert.equal(isSafeArtifactSegment('a'.repeat(255)), true)
  assert.equal(isSafeArtifactSegment('a'.repeat(256)), false)
  assert.throws(
    () => deriveReleaseAssetName(long),
    /safe Release asset name/,
    long,
  )
})

test('a folded name is itself a safe flat segment', () => {
  assert.equal(
    isSafeArtifactSegment(deriveReleaseAssetName('skills/coach/SKILL.md')),
    true,
  )
})

test('accepts an artifact set with distinct paths and names', () => {
  assert.doesNotThrow(() =>
    assertReleaseAssetUniqueness(
      [
        { path: 'entry.js', name: 'entry.js' },
        { path: 'style.css', name: 'style.css' },
        { path: 'skills/coach/SKILL.md', name: 'skills__coach__SKILL.md' },
        { path: 'skills/coach.md', name: 'skills__coach.md' },
      ],
      'fixture',
    ),
  )
})

for (const [label, files, error] of [
  [
    'a duplicate path',
    [
      { path: 'skills/skill.md', name: 'skills__skill.md' },
      { path: 'skills/skill.md', name: 'other.md' },
    ],
    /duplicate artifact path/,
  ],
  [
    'a path that only differs by case',
    [
      { path: 'skills/Coach/SKILL.md', name: 'skills__Coach__SKILL.md' },
      { path: 'skills/coach/SKILL.md', name: 'skills__coach__SKILL.md' },
    ],
    /duplicate artifact path/,
  ],
  [
    'a duplicate asset name',
    [
      { path: 'skills/coach.md', name: 'skills__coach.md' },
      { path: 'skills/coach/SKILL.md', name: 'skills__coach.md' },
    ],
    /duplicate asset name/,
  ],
  [
    'an asset name that only differs by case',
    [
      { path: 'skills/coach.md', name: 'skills__coach.md' },
      { path: 'other.md', name: 'Skills__Coach.md' },
    ],
    /duplicate asset name/,
  ],
  [
    'a path that aliases its own directory',
    [
      { path: 'skills/coach', name: 'skills__coach' },
      { path: 'skills/coach/SKILL.md', name: 'skills__coach__SKILL.md' },
    ],
    /aliases a directory/,
  ],
  [
    'the reserved manifest path',
    [{ path: 'module.json', name: 'module.json' }],
    /reserved/,
  ],
  [
    'a Release-level asset name',
    [{ path: 'release-note.md', name: 'release-note.md' }],
    /reserved/,
  ],
]) {
  test(`rejects an artifact set with ${label}`, () => {
    assert.throws(() => assertReleaseAssetUniqueness(files, 'fixture'), error)
  })
}
