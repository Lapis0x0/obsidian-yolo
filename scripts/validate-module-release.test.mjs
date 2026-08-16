import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const moduleId = 'zz-validate-release-fixture'
const version = '0.0.1'
const tag = `${moduleId}/v${version}`

test('validates a release whose artifacts install into nested directories', async () => {
  const fixture = await createFixture()
  try {
    const { stdout } = await validate(fixture, ['--build'])
    assert.match(stdout, new RegExp(`Validated ${moduleId} ${version}`))

    // A GitHub Release namespace is flat: every artifact is staged under its
    // folded asset name, while the manifest keeps the installed path.
    assert.deepEqual((await readdir(fixture.artifactDir)).sort(), [
      'entry.js',
      'module-config.json',
      'module.json',
      'release-note.md',
      'skills__coach__SKILL.md',
      'skills__coach__references__fsrs.md',
    ])
    const manifest = await readManifest(fixture)
    assert.deepEqual(
      manifest.variants[0].files
        .filter(({ role }) => role === 'data')
        .map(({ path: filePath, name }) => [filePath, name]),
      [
        ['skills/coach/SKILL.md', 'skills__coach__SKILL.md'],
        [
          'skills/coach/references/fsrs.md',
          'skills__coach__references__fsrs.md',
        ],
      ],
    )
  } finally {
    await fixture.cleanup()
  }
})

for (const [label, tamper, error] of [
  [
    'an asset name that does not fold its path',
    (file) => {
      file.name = 'SKILL.md'
      file.url = file.url.replace(/[^/]+$/, 'SKILL.md')
    },
    /does not fold its path/,
  ],
  [
    'an installed path that only differs from another by case',
    (file) => {
      file.path = 'skills/Coach/SKILL.md'
      file.name = 'skills__Coach__SKILL.md'
      file.url = file.url.replace(/[^/]+$/, file.name)
    },
    /duplicate artifact path/,
  ],
  [
    'an installed path that escapes the version directory',
    (file) => {
      file.path = 'skills/../../SKILL.md'
      file.name = 'skills__..__..__SKILL.md'
      file.url = file.url.replace(/[^/]+$/, file.name)
    },
    /safe relative/,
  ],
  [
    'the same artifact twice inside one variant',
    (file, files) => {
      // The Host parses each variant's file list as it stands and refuses the
      // repeat, so a check that folds the list by path first — and silently
      // collapses the repeat — would pass a release that cannot be installed.
      files.push({ ...file })
    },
    /duplicate artifact path/,
  ],
  [
    'an asset URL that does not address its own name',
    (file) => {
      file.url = file.url.replace(/[^/]+$/, 'entry.js')
    },
    /manifest file is invalid/,
  ],
]) {
  test(`rejects a release declaring ${label}`, async () => {
    const fixture = await createFixture()
    try {
      await validate(fixture, ['--build'])
      const manifest = await readManifest(fixture)
      for (const variant of manifest.variants) {
        const files = variant.files
        tamper(files[files.length - 1], files)
      }
      await writeFile(
        path.join(fixture.artifactDir, 'module.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
      await assert.rejects(validate(fixture, []), error)
    } finally {
      await fixture.cleanup()
    }
  })
}

async function validate(fixture, extraArgs) {
  return execFileAsync(
    process.execPath,
    [
      'scripts/validate-module-release.mjs',
      ...extraArgs,
      '--module',
      moduleId,
      '--output-dir',
      fixture.artifactDir,
    ],
    { cwd: repositoryRoot, env: { ...process.env, MODULE_RELEASE_TAG: tag } },
  )
}

async function readManifest(fixture) {
  return JSON.parse(
    await readFile(path.join(fixture.artifactDir, 'module.json'), 'utf8'),
  )
}

/**
 * Scaffolds a throwaway first-party module under the real `modules/` root —
 * `loadOfficialModules()` hardcodes that scan root — shipping a nested skill
 * package, plus the release note the validator requires.
 */
async function createFixture() {
  const moduleDir = path.join(repositoryRoot, 'modules', moduleId)
  const root = await mkdtemp(path.join(os.tmpdir(), 'module-release-validate-'))
  const cleanup = async () => {
    await rm(root, { recursive: true, force: true })
    await rm(moduleDir, { recursive: true, force: true })
  }
  try {
    const dataFiles = [
      'skills/coach/SKILL.md',
      'skills/coach/references/fsrs.md',
    ]
    await mkdir(path.join(moduleDir, 'src', 'skills', 'coach', 'references'), {
      recursive: true,
    })
    await writeFile(
      path.join(moduleDir, 'module.config.json'),
      JSON.stringify({
        id: moduleId,
        icon: 'graduation-cap',
        localizations: { en: { name: 'Fixture', description: 'Fixture.' } },
        hostApi: '^1.0.0',
        platforms: ['desktop'],
        dataSchemas: {},
        dataFiles,
      }),
    )
    await writeFile(
      path.join(moduleDir, 'package.json'),
      JSON.stringify({
        name: moduleId,
        version,
        yoloModule: {
          previewVersion: '0.0.2',
          previewTag: `module-${moduleId}-v0.0.2`,
        },
      }),
    )
    await writeFile(path.join(moduleDir, 'src', 'index.tsx'), 'export {}\n')
    await writeFile(
      path.join(moduleDir, 'latest-release-note.md'),
      `## ${version} Fixture\n\n- Fixture\n\n---\n\n## ${version} 固定件\n\n- 固定件\n`,
    )
    for (const dataFile of dataFiles) {
      await writeFile(
        path.join(moduleDir, 'src', dataFile),
        `---\nname: ${path.posix.basename(dataFile)}\n---\nFixture.\n`,
      )
    }
    return { artifactDir: path.join(root, 'release'), cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
