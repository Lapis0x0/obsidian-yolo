// eslint-disable-next-line import/no-nodejs-modules -- artifact hashing fixture runs only in Jest/Node
import { createHash, webcrypto } from 'node:crypto'

import {
  MAX_MODULE_SKILL_PROJECTION_DEPTH,
  MAX_MODULE_SKILL_PROJECTION_ENTRIES,
  type ModuleSkillProjectionVaultV1,
  createModuleSkillMaterializer,
  planModuleSkillPackages,
  resolveModuleSkillPackageName,
  resolveModuleSkillVaultPath,
} from './moduleSkillMaterializer'
import type { ModuleArtifactFile, ModuleArtifactManifest } from './moduleStore'

const SUBTLE = webcrypto.subtle as unknown as SubtleCrypto
const MODULE_ID = 'learning'
const VERSION = '1.0.0'
const SKILLS_DIR = 'YOLO/modules/learning/skills'
const MODULE_DIR = 'YOLO/modules/learning'
const MODULES_ROOT = 'YOLO/modules'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

function artifactFile(
  role: ModuleArtifactFile['role'],
  path: string,
  bytes: Uint8Array,
): ModuleArtifactFile {
  const name = path.split('/').join('-')
  return Object.freeze({
    role,
    name,
    path,
    byteSize: bytes.byteLength,
    sha256: sha256(bytes),
    url: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-${MODULE_ID}-v${VERSION}/${name}`,
    storage: 'module' as const,
  })
}

/** Builds a verified artifact plus the bytes its `ModuleStore` would serve. */
function buildArtifact(contents: Readonly<Record<string, string>>) {
  const files: ModuleArtifactFile[] = [
    artifactFile('entry', 'entry.js', encode('entry')),
  ]
  const bytesByPath = new Map<string, Uint8Array>([
    ['entry.js', encode('entry')],
  ])
  for (const [path, text] of Object.entries(contents)) {
    const bytes = encode(text)
    files.push(artifactFile('data', path, bytes))
    bytesByPath.set(path, bytes)
  }
  const manifest: ModuleArtifactManifest = Object.freeze({
    schemaVersion: 1,
    id: MODULE_ID,
    version: VERSION,
    hostApi: '^1.0.0',
    dataSchemas: Object.freeze({}),
    variants: Object.freeze([
      Object.freeze({
        platform: 'desktop' as const,
        entry: 'entry.js',
        files: Object.freeze(files),
      }),
    ]),
  })
  return {
    artifact: Object.freeze({
      manifest,
      variant: manifest.variants[0],
      entryBytes: encode('entry'),
    }),
    store: {
      readEntryBytes: jest.fn(
        async (_moduleId: string, _version: string, path: string) => {
          const bytes = bytesByPath.get(path)
          if (!bytes) throw new Error(`missing artifact file: ${path}`)
          return bytes
        },
      ),
    },
  }
}

type FakeVault = ModuleSkillProjectionVaultV1 & {
  files: Map<string, Uint8Array>
  dirs: Set<string>
  writes: string[]
  removedFiles: string[]
  removedDirs: string[]
  /** Every mutation in the order it was issued. */
  ops: string[]
  snapshot(): Record<string, string>
}

function createFakeVault(
  initial: Readonly<Record<string, string>> = {},
): FakeVault {
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>()
  const writes: string[] = []
  const removedFiles: string[] = []
  const removedDirs: string[] = []
  const ops: string[] = []
  const addDirsFor = (path: string) => {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      dirs.add(segments.slice(0, index).join('/'))
    }
  }
  for (const [path, text] of Object.entries(initial)) {
    files.set(path, encode(text))
    addDirsFor(path)
  }
  const childrenOf = (dir: string) => {
    const prefix = `${dir}/`
    const directFiles = [...files.keys()].filter(
      (path) =>
        path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
    )
    const directFolders = [...dirs].filter(
      (path) =>
        path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
    )
    return { files: directFiles, folders: directFolders }
  }
  return {
    files,
    dirs,
    writes,
    removedFiles,
    removedDirs,
    ops,
    snapshot: () =>
      Object.fromEntries(
        [...files.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]),
      ),
    list: async (dir) => (dirs.has(dir) ? childrenOf(dir) : null),
    read: async (path) => {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`missing: ${path}`)
      return bytes
    },
    write: async (path, bytes) => {
      writes.push(path)
      ops.push(`write:${path}`)
      files.set(path, bytes)
      addDirsFor(path)
    },
    removeFile: async (path) => {
      removedFiles.push(path)
      ops.push(`removeFile:${path}`)
      files.delete(path)
    },
    removeDir: async (path) => {
      removedDirs.push(path)
      ops.push(`removeDir:${path}`)
      dirs.delete(path)
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${path}/`)) files.delete(key)
      }
      for (const key of [...dirs]) {
        if (key.startsWith(`${path}/`)) dirs.delete(key)
      }
    },
  }
}

function createMaterializer(
  vault: ModuleSkillProjectionVaultV1,
  store: { readEntryBytes: jest.Mock },
) {
  return createModuleSkillMaterializer({
    vault,
    store: store as unknown as Parameters<
      typeof createModuleSkillMaterializer
    >[0]['store'],
    getSkillsDir: () => SKILLS_DIR,
    getModuleDir: () => MODULE_DIR,
    getModulesRootDir: () => MODULES_ROOT,
    subtleCrypto: SUBTLE,
  })
}

describe('resolveModuleSkillPackageName', () => {
  it('takes the directory containing SKILL.md as the package name', () => {
    expect(resolveModuleSkillPackageName('skills/coach/SKILL.md')).toBe('coach')
    expect(resolveModuleSkillPackageName('a/b/c/SKILL.md')).toBe('c')
  })

  it('rejects anything that is not a package entry path', () => {
    expect(resolveModuleSkillPackageName('SKILL.md')).toBeNull()
    expect(resolveModuleSkillPackageName('skills/coach/index.md')).toBeNull()
    expect(resolveModuleSkillPackageName('skills/coach/skill.md')).toBeNull()
    expect(resolveModuleSkillPackageName('../escape/SKILL.md')).toBeNull()
    expect(resolveModuleSkillPackageName('/abs/SKILL.md')).toBeNull()
  })
})

describe('resolveModuleSkillVaultPath', () => {
  it('is the single definition shared by projection and lookup', () => {
    expect(
      resolveModuleSkillVaultPath(SKILLS_DIR, 'skills/coach/SKILL.md'),
    ).toBe(`${SKILLS_DIR}/coach/SKILL.md`)
    expect(resolveModuleSkillVaultPath(SKILLS_DIR, 'coach.md')).toBeNull()
  })
})

describe('planModuleSkillPackages', () => {
  const files = [
    artifactFile('entry', 'entry.js', encode('entry')),
    artifactFile('data', 'skills/coach/SKILL.md', encode('skill')),
    artifactFile('data', 'skills/coach/references/rubric.md', encode('rubric')),
    artifactFile('data', 'skills/other/SKILL.md', encode('other')),
    artifactFile('style', 'skills/coach/style.css', encode('css')),
  ]

  it('collects every declared role:data file inside the package directory', () => {
    const [plan] = planModuleSkillPackages({
      moduleId: MODULE_ID,
      skillsDir: SKILLS_DIR,
      files,
      declaredSkillPaths: ['skills/coach/SKILL.md'],
    })

    expect(plan.packageName).toBe('coach')
    expect(plan.entryVaultPath).toBe(`${SKILLS_DIR}/coach/SKILL.md`)
    expect(plan.files.map((planned) => planned.vaultPath)).toEqual([
      `${SKILLS_DIR}/coach/SKILL.md`,
      `${SKILLS_DIR}/coach/references/rubric.md`,
    ])
  })

  it('rejects a declaration with no matching role:data artifact file', () => {
    expect(() =>
      planModuleSkillPackages({
        moduleId: MODULE_ID,
        skillsDir: SKILLS_DIR,
        files,
        declaredSkillPaths: ['skills/missing/SKILL.md'],
      }),
    ).toThrow(/is not a declared role:data artifact file/)
  })

  it('rejects a non-package declaration', () => {
    expect(() =>
      planModuleSkillPackages({
        moduleId: MODULE_ID,
        skillsDir: SKILLS_DIR,
        files,
        declaredSkillPaths: ['entry.js'],
      }),
    ).toThrow(/must be a package path/)
  })

  it('rejects two declarations that claim the same vault directory', () => {
    const collidingFiles = [
      ...files,
      artifactFile('data', 'extra/coach/SKILL.md', encode('dup')),
    ]
    expect(() =>
      planModuleSkillPackages({
        moduleId: MODULE_ID,
        skillsDir: SKILLS_DIR,
        files: collidingFiles,
        declaredSkillPaths: ['skills/coach/SKILL.md', 'extra/coach/SKILL.md'],
      }),
    ).toThrow(/two skill packages named "coach"/)
  })

  // `Coach` and `coach` are distinct manifest paths but a single directory on
  // macOS and Windows: without a canonical key the second projection would
  // overwrite the first and one mode would silently resolve the other's skill.
  it('rejects package names that collide only on a case-insensitive filesystem', () => {
    const collidingFiles = [
      ...files,
      artifactFile('data', 'extra/Coach/SKILL.md', encode('dup')),
    ]
    expect(() =>
      planModuleSkillPackages({
        moduleId: MODULE_ID,
        skillsDir: SKILLS_DIR,
        files: collidingFiles,
        declaredSkillPaths: ['skills/coach/SKILL.md', 'extra/Coach/SKILL.md'],
      }),
    ).toThrow(/two skill packages named "Coach"/)
  })

  it('rejects a package whose declared files exceed the projection entry limit', () => {
    const bulk = Array.from(
      { length: MAX_MODULE_SKILL_PROJECTION_ENTRIES + 1 },
      (_, index) =>
        artifactFile('data', `skills/big/f${index}.md`, encode(`f${index}`)),
    )
    expect(() =>
      planModuleSkillPackages({
        moduleId: MODULE_ID,
        skillsDir: SKILLS_DIR,
        files: [
          artifactFile('data', 'skills/big/SKILL.md', encode('skill')),
          ...bulk,
        ],
        declaredSkillPaths: ['skills/big/SKILL.md'],
      }),
    ).toThrow(/exceed the projection entry limit/)
  })

  it('rejects a declared file nested deeper than the projection depth limit', () => {
    const deep = `skills/deep/${Array.from(
      { length: MAX_MODULE_SKILL_PROJECTION_DEPTH },
      (_, index) => `d${index}`,
    ).join('/')}/leaf.md`
    expect(() =>
      planModuleSkillPackages({
        moduleId: MODULE_ID,
        skillsDir: SKILLS_DIR,
        files: [
          artifactFile('data', 'skills/deep/SKILL.md', encode('skill')),
          artifactFile('data', deep, encode('leaf')),
        ],
        declaredSkillPaths: ['skills/deep/SKILL.md'],
      }),
    ).toThrow(/exceeds the projection depth limit/)
  })
})

describe('createModuleSkillMaterializer', () => {
  it('projects a package and all its resources as real vault files', async () => {
    const { artifact, store } = buildArtifact({
      'skills/coach/SKILL.md': 'skill body',
      'skills/coach/references/rubric.md': 'rubric body',
      'skills/unrelated.md': 'not part of the package',
    })
    const vault = createFakeVault()
    const materializer = createMaterializer(vault, store)

    await materializer.materialize(MODULE_ID, artifact, [
      'skills/coach/SKILL.md',
    ])

    expect(vault.snapshot()).toEqual({
      [`${SKILLS_DIR}/coach/SKILL.md`]: 'skill body',
      [`${SKILLS_DIR}/coach/references/rubric.md`]: 'rubric body',
    })
  })

  it('rewrites nothing when the projection already matches the artifact', async () => {
    const { artifact, store } = buildArtifact({
      'skills/coach/SKILL.md': 'skill body',
    })
    const vault = createFakeVault()
    const materializer = createMaterializer(vault, store)

    await materializer.materialize(MODULE_ID, artifact, [
      'skills/coach/SKILL.md',
    ])
    vault.writes.length = 0
    await materializer.materialize(MODULE_ID, artifact, [
      'skills/coach/SKILL.md',
    ])

    expect(vault.writes).toEqual([])
  })

  it('overwrites a locally edited projection without asking', async () => {
    const { artifact, store } = buildArtifact({
      'skills/coach/SKILL.md': 'artifact body',
    })
    const vault = createFakeVault({
      [`${SKILLS_DIR}/coach/SKILL.md`]: 'user edit',
    })
    const materializer = createMaterializer(vault, store)

    await materializer.materialize(MODULE_ID, artifact, [
      'skills/coach/SKILL.md',
    ])

    expect(vault.snapshot()).toEqual({
      [`${SKILLS_DIR}/coach/SKILL.md`]: 'artifact body',
    })
  })

  it('drops files a newer version no longer ships', async () => {
    const { artifact, store } = buildArtifact({
      'skills/coach/SKILL.md': 'v2 body',
    })
    const vault = createFakeVault({
      [`${SKILLS_DIR}/coach/SKILL.md`]: 'v1 body',
      [`${SKILLS_DIR}/coach/references/removed.md`]: 'v1 leftover',
    })
    const materializer = createMaterializer(vault, store)

    await materializer.materialize(MODULE_ID, artifact, [
      'skills/coach/SKILL.md',
    ])

    expect(vault.snapshot()).toEqual({
      [`${SKILLS_DIR}/coach/SKILL.md`]: 'v2 body',
    })
    expect(vault.removedDirs).toContain(`${SKILLS_DIR}/coach/references`)
  })

  it('removes the whole projection when the declarations disappear', async () => {
    const { artifact, store } = buildArtifact({})
    const vault = createFakeVault({
      [`${SKILLS_DIR}/coach/SKILL.md`]: 'stale',
    })
    const materializer = createMaterializer(vault, store)

    await materializer.materialize(MODULE_ID, artifact, [])

    expect(vault.snapshot()).toEqual({})
    expect(vault.removedDirs).toEqual(
      expect.arrayContaining([
        `${SKILLS_DIR}/coach`,
        SKILLS_DIR,
        MODULE_DIR,
        MODULES_ROOT,
      ]),
    )
  })

  it('creates nothing for a module that declares no skills', async () => {
    const { artifact, store } = buildArtifact({})
    const vault = createFakeVault()
    const materializer = createMaterializer(vault, store)

    await materializer.materialize(MODULE_ID, artifact, [])

    expect(vault.snapshot()).toEqual({})
    expect(vault.writes).toEqual([])
  })

  it('refuses to project bytes that do not match the manifest hash', async () => {
    const { artifact, store } = buildArtifact({
      'skills/coach/SKILL.md': 'skill body',
    })
    store.readEntryBytes.mockImplementation(async () => encode('tampered'))
    const vault = createFakeVault()
    const materializer = createMaterializer(vault, store)

    await expect(
      materializer.materialize(MODULE_ID, artifact, ['skills/coach/SKILL.md']),
    ).rejects.toThrow(/SHA-256 mismatch/)
    expect(vault.snapshot()).toEqual({})
  })

  // The projection root is a user-visible, agent-writable Vault directory:
  // sync conflict copies, a stray `bash mkdir -p`, or a pasted folder can put
  // arbitrarily much there. Refusing to enumerate it would make the module
  // fail to project on every future activation — the exact state the
  // reconciliation exists to clear.
  it('resets a projection root holding more entries than it can enumerate', async () => {
    const { artifact, store } = buildArtifact({
      'skills/coach/SKILL.md': 'skill body',
    })
    const junk: Record<string, string> = {}
    for (let index = 0; index <= MAX_MODULE_SKILL_PROJECTION_ENTRIES; index++) {
      junk[`${SKILLS_DIR}/conflict/note-${index}.md`] = 'sync conflict copy'
    }
    const vault = createFakeVault(junk)
    const materializer = createMaterializer(vault, store)

    await materializer.materialize(MODULE_ID, artifact, [
      'skills/coach/SKILL.md',
    ])

    expect(vault.removedDirs).toContain(SKILLS_DIR)
    expect(vault.snapshot()).toEqual({
      [`${SKILLS_DIR}/coach/SKILL.md`]: 'skill body',
    })
  })

  // The expected paths come from the manifest and the existing ones from the
  // Vault, so a package renamed from `Coach` to `coach` is one physical file
  // on macOS and Windows. Comparing the two sides as exact strings would have
  // the removal pass delete the file the write pass had just produced.
  it('converges a package renamed only by case in a single pass', async () => {
    const { artifact, store } = buildArtifact({
      'skills/coach/SKILL.md': 'v2 body',
    })
    const vault = createFakeVault({
      [`${SKILLS_DIR}/Coach/SKILL.md`]: 'v1 body',
    })
    const materializer = createMaterializer(vault, store)

    await materializer.materialize(MODULE_ID, artifact, [
      'skills/coach/SKILL.md',
    ])

    expect(vault.snapshot()).toEqual({
      [`${SKILLS_DIR}/coach/SKILL.md`]: 'v2 body',
    })
    // The old casing is dropped *before* the write and never touched after
    // it: on a case-insensitive filesystem the removal would otherwise take
    // the file that was just written.
    expect(vault.ops).toEqual([
      `removeFile:${SKILLS_DIR}/Coach/SKILL.md`,
      `write:${SKILLS_DIR}/coach/SKILL.md`,
      `removeDir:${SKILLS_DIR}/Coach`,
    ])
  })

  it('keeps an overflowing root until every replacement byte is in hand', async () => {
    const { artifact, store } = buildArtifact({
      'skills/coach/SKILL.md': 'skill body',
    })
    store.readEntryBytes.mockImplementation(async () => {
      throw new Error('artifact file is gone')
    })
    const junk: Record<string, string> = {}
    for (let index = 0; index <= MAX_MODULE_SKILL_PROJECTION_ENTRIES; index++) {
      junk[`${SKILLS_DIR}/conflict/note-${index}.md`] = 'sync conflict copy'
    }
    const vault = createFakeVault(junk)
    const materializer = createMaterializer(vault, store)

    await expect(
      materializer.materialize(MODULE_ID, artifact, ['skills/coach/SKILL.md']),
    ).rejects.toThrow(/artifact file is gone/)

    // The reset is unconditional, so it may only run once the bytes that
    // replace what it deletes are read and verified.
    expect(vault.removedDirs).toEqual([])
    expect(vault.snapshot()).toEqual(junk)
  })

  it('resets a projection root nested deeper than it can enumerate', async () => {
    const { artifact, store } = buildArtifact({
      'skills/coach/SKILL.md': 'skill body',
    })
    const deep = Array.from(
      { length: MAX_MODULE_SKILL_PROJECTION_DEPTH + 1 },
      (_, index) => `d${index}`,
    ).join('/')
    const vault = createFakeVault({
      [`${SKILLS_DIR}/${deep}/note.md`]: 'someone ran mkdir -p',
    })
    const materializer = createMaterializer(vault, store)

    await materializer.materialize(MODULE_ID, artifact, [
      'skills/coach/SKILL.md',
    ])

    expect(vault.removedDirs).toContain(SKILLS_DIR)
    expect(vault.snapshot()).toEqual({
      [`${SKILLS_DIR}/coach/SKILL.md`]: 'skill body',
    })
  })

  it('rejects an artifact belonging to another module', async () => {
    const { artifact, store } = buildArtifact({
      'skills/coach/SKILL.md': 'skill body',
    })
    const vault = createFakeVault()
    const materializer = createMaterializer(vault, store)

    await expect(
      materializer.materialize('other-module', artifact, [
        'skills/coach/SKILL.md',
      ]),
    ).rejects.toThrow(/artifact identity mismatch/)
  })

  it('remove() drops the module projection and prunes the shared root', async () => {
    const vault = createFakeVault({
      [`${SKILLS_DIR}/coach/SKILL.md`]: 'skill body',
    })
    const { store } = buildArtifact({})
    const materializer = createMaterializer(vault, store)

    await materializer.remove(MODULE_ID)

    expect(vault.snapshot()).toEqual({})
    expect(vault.removedDirs).toEqual([MODULE_DIR, MODULES_ROOT])
  })

  it('remove() keeps a modules root that still hosts another module', async () => {
    const vault = createFakeVault({
      [`${SKILLS_DIR}/coach/SKILL.md`]: 'skill body',
      'YOLO/modules/other/skills/x/SKILL.md': 'other module',
    })
    const { store } = buildArtifact({})
    const materializer = createMaterializer(vault, store)

    await materializer.remove(MODULE_ID)

    expect(vault.snapshot()).toEqual({
      'YOLO/modules/other/skills/x/SKILL.md': 'other module',
    })
    expect(vault.removedDirs).toEqual([MODULE_DIR])
  })
})
