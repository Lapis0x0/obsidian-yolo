import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

const execFileAsync = promisify(execFile)
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const workerSymbol = 'yolo.module.inline-worker.v1:learning:ankiParser'
const runtimeSymbol = 'yolo.module.host-runtime.v1'

test('builds and loads the complete Learning UI entry with the Host React identities', async () => {
  const fixture = await buildFixture()
  try {
    const entrySource = await readFile(
      path.join(fixture.artifactDir, 'entry.js'),
      'utf8',
    )
    let registration
    const context = vm.createContext({
      AbortController,
      Blob,
      console,
      crypto: globalThis.crypto,
      setTimeout,
      clearTimeout,
      yolo: {
        registerModule(nextRegistration) {
          registration = nextRegistration
        },
      },
    })
    context[Symbol.for(runtimeSymbol)] = { react: React, jsxRuntime }

    assert.doesNotThrow(() => new vm.Script(entrySource).runInContext(context))
    assert.equal(registration?.id, 'learning')
    assert.equal(typeof registration?.activate, 'function')

    const metafile = JSON.parse(await readFile(fixture.metafilePath, 'utf8'))
    assert.ok(metafile.inputs.includes('yolo-module-runtime:react'))
    assert.ok(metafile.inputs.includes('yolo-module-runtime:jsx-runtime'))
    assert.equal(
      metafile.inputs.some((input) =>
        /(^|\/)node_modules\/react(?:\/|$)/.test(input.replaceAll('\\', '/')),
      ),
      false,
      'the module must not bundle a second React implementation',
    )
    assert.equal(
      metafile.inputs.some((input) =>
        /(^|\/)node_modules\/react-dom\/client(?:\.js|\/|$)/.test(
          input.replaceAll('\\', '/'),
        ),
      ),
      false,
      'the module UI must leave root creation to the Host',
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('builds a Host-consumable Anki worker inside the Learning artifact', async () => {
  const fixture = await buildFixture()
  try {
    assert.deepEqual((await readdir(fixture.artifactDir)).sort(), [
      'entry.js',
      'module.json',
      'style.css',
    ])

    const entrySource = await readFile(
      path.join(fixture.artifactDir, 'entry.js'),
      'utf8',
    )
    const workerSource = extractWorkerSource(entrySource)
    assert.ok(workerSource.length > 100_000, 'worker source must not be a stub')
    assert.doesNotThrow(() => new vm.Script(workerSource))
    assert.equal(workerSource.includes(runtimeSymbol), false)
    assert.equal(workerSource.includes('react.development.js'), false)

    const worker = runWorker(workerSource)
    worker.send({
      id: 'parse-request',
      packageBytes: new ArrayBuffer(2),
      wasmBytes: new ArrayBuffer(0),
    })
    const parseResponse = await waitForResponse(
      worker.responses,
      'parse-request',
    )
    assert.equal(parseResponse.id, 'parse-request')
    assert.match(parseResponse.error, /Corrupted zip/)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('keeps hashes and the module metafile self-contained', async () => {
  const fixture = await buildFixture()
  try {
    const manifest = JSON.parse(
      await readFile(path.join(fixture.artifactDir, 'module.json'), 'utf8'),
    )
    assert.deepEqual(
      manifest.variants.map(({ platform }) => platform),
      ['desktop', 'mobile'],
    )
    for (const variant of manifest.variants) {
      assert.deepEqual(
        variant.files.map(({ path: filePath }) => filePath),
        ['entry.js', 'style.css'],
      )
      for (const file of variant.files) {
        const bytes = await readFile(path.join(fixture.artifactDir, file.path))
        assert.equal(file.byteSize, bytes.byteLength)
        assert.equal(file.sha256, hash(bytes))
      }
    }

    const metafile = JSON.parse(await readFile(fixture.metafilePath, 'utf8'))
    assert.deepEqual(metafile.entryImports, [])
    assert.ok(
      metafile.inputs.some((input) =>
        input.endsWith('modules/learning/src/anki/worker/entry.ts'),
      ),
    )
    for (const dependency of ['fzstd', 'jszip', 'parse5', 'sql.js']) {
      assert.ok(
        metafile.inputs.some((input) =>
          input.replaceAll('\\', '/').includes(`node_modules/${dependency}/`),
        ),
        `${dependency} must be bundled into the worker source`,
      )
    }
    assert.equal(
      metafile.inputs.some((input) =>
        /(^|\/)src\/core\//.test(input.replaceAll('\\', '/')),
      ),
      false,
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('module.config.json dataFiles ship as flat role:data artifacts (D6 skills pipeline)', async () => {
  const moduleId = 'zz-datafiles-fixture'
  const fixture = await buildDataFilesFixture(moduleId, {
    dataFiles: ['fixture-skill.md'],
  })
  try {
    assert.deepEqual((await readdir(fixture.artifactDir)).sort(), [
      'entry.js',
      'fixture-skill.md',
      'module.json',
    ])

    const shippedBytes = await readFile(
      path.join(fixture.artifactDir, 'fixture-skill.md'),
    )
    assert.equal(shippedBytes.toString('utf8'), fixture.skillContent)

    const manifest = JSON.parse(
      await readFile(path.join(fixture.artifactDir, 'module.json'), 'utf8'),
    )
    for (const variant of manifest.variants) {
      const dataFile = variant.files.find(
        (file) => file.path === 'fixture-skill.md',
      )
      assert.ok(dataFile, 'manifest must declare the data artifact')
      assert.equal(dataFile.role, 'data')
      assert.equal(dataFile.name, 'fixture-skill.md')
      assert.equal(dataFile.storage, 'module')
      assert.equal(dataFile.byteSize, shippedBytes.byteLength)
      assert.equal(dataFile.sha256, hash(shippedBytes))
    }
  } finally {
    await fixture.cleanup()
  }
})

test('nested dataFiles install at their path and upload under a folded name', async () => {
  const moduleId = 'zz-datafiles-tree-fixture'
  const fixture = await buildDataFilesFixture(moduleId, {
    dataFiles: ['skills/coach/SKILL.md', 'skills/coach/references/fsrs.md'],
  })
  try {
    assert.deepEqual(await listFiles(fixture.artifactDir), [
      'entry.js',
      'module.json',
      'skills/coach/SKILL.md',
      'skills/coach/references/fsrs.md',
    ])

    const manifest = JSON.parse(
      await readFile(path.join(fixture.artifactDir, 'module.json'), 'utf8'),
    )
    for (const variant of manifest.variants) {
      const files = variant.files.filter(({ role }) => role === 'data')
      assert.deepEqual(
        files.map(({ path: filePath, name }) => [filePath, name]),
        [
          ['skills/coach/SKILL.md', 'skills__coach__SKILL.md'],
          [
            'skills/coach/references/fsrs.md',
            'skills__coach__references__fsrs.md',
          ],
        ],
      )
      for (const file of files) {
        const bytes = await readFile(path.join(fixture.artifactDir, file.path))
        assert.equal(bytes.toString('utf8'), fixture.skillContent)
        assert.equal(file.byteSize, bytes.byteLength)
        assert.equal(file.sha256, hash(bytes))
        assert.equal(
          file.url,
          `https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-${moduleId}-v0.0.1/${file.name}`,
        )
      }
    }
  } finally {
    await fixture.cleanup()
  }
})

test('--layout flat stages nested artifacts under their Release asset name', async () => {
  const moduleId = 'zz-datafiles-flat-fixture'
  const fixture = await buildDataFilesFixture(moduleId, {
    dataFiles: ['skills/coach/SKILL.md'],
    layout: 'flat',
  })
  try {
    assert.deepEqual(await listFiles(fixture.artifactDir), [
      'entry.js',
      'module.json',
      'skills__coach__SKILL.md',
    ])

    const manifest = JSON.parse(
      await readFile(path.join(fixture.artifactDir, 'module.json'), 'utf8'),
    )
    const [file] = manifest.variants[0].files.filter(
      ({ role }) => role === 'data',
    )
    // The staged bytes are the artifact's bytes: layout never changes identity.
    const bytes = await readFile(path.join(fixture.artifactDir, file.name))
    assert.equal(file.path, 'skills/coach/SKILL.md')
    assert.equal(file.name, 'skills__coach__SKILL.md')
    assert.equal(file.sha256, hash(bytes))
  } finally {
    await fixture.cleanup()
  }
})

for (const [label, dataFiles, error] of [
  ['escapes the module source tree', ['../outside.md'], /safe relative/],
  ['is absolute', ['/etc/passwd'], /safe relative/],
  ['uses a Windows separator', ['skills\\coach.md'], /safe relative/],
  [
    'is not foldable into a flat name',
    ['skills__coach.md'],
    /must not contain "__"/,
  ],
  [
    'only differs from another entry by case',
    ['skills/coach.md', 'skills/Coach.md'],
    /duplicate entry/,
  ],
  [
    'only differs from another entry by directory case',
    ['skills/coach/SKILL.md', 'skills/Coach/SKILL.md'],
    /duplicate entry/,
  ],
  [
    'reuses a Release-level asset name',
    ['release-note.md'],
    /artifact file is reserved/,
  ],
]) {
  test(`module.config.json rejects a dataFiles entry that ${label}`, async () => {
    const moduleId = 'zz-datafiles-invalid-fixture'
    await assert.rejects(buildDataFilesFixture(moduleId, { dataFiles }), error)
    await rm(path.join(repositoryRoot, 'modules', moduleId), {
      recursive: true,
      force: true,
    })
  })
}

test('module.config.json rejects a dataFiles entry missing from src/', async () => {
  const moduleId = 'zz-datafiles-missing-fixture'
  await assert.rejects(
    buildDataFilesFixture(moduleId, {
      dataFiles: ['missing-skill.md'],
      skipWritingSkillFile: true,
    }),
    /missing from src\//,
  )
  await rm(path.join(repositoryRoot, 'modules', moduleId), {
    recursive: true,
    force: true,
  })
})

/**
 * Scaffolds a minimal, throwaway first-party module directory under the real
 * `modules/` root (required — `loadOfficialModules()` hardcodes that scan
 * root) declaring `dataFiles`, builds it via the actual CLI, and returns a
 * `cleanup()` that removes both the scaffolded module directory and the
 * build's output directory. The module directory is removed even when the
 * build throws, so validation-failure tests never leak fixture state.
 */
async function buildDataFilesFixture(
  moduleId,
  { dataFiles, skipWritingSkillFile = false, layout },
) {
  const moduleDir = path.join(repositoryRoot, 'modules', moduleId)
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'module-datafiles-build-'),
  )
  const artifactDir = path.join(root, 'artifact')
  const skillContent = '---\nname: fixture-skill\n---\nFixture skill body.\n'
  try {
    await mkdir(path.join(moduleDir, 'src'), { recursive: true })
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
        version: '0.0.1',
        yoloModule: {
          previewVersion: '0.0.1',
          previewTag: `module-${moduleId}-v0.0.1`,
        },
      }),
    )
    await writeFile(
      path.join(moduleDir, 'src', 'index.tsx'),
      'export {}\n',
    )
    if (!skipWritingSkillFile) {
      for (const fileName of dataFiles) {
        // Only write sources the file system can hold: invalid-path fixtures
        // must fail on the declaration, never on a stray write.
        if (!/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/.test(fileName)) continue
        const source = path.join(moduleDir, 'src', fileName)
        await mkdir(path.dirname(source), { recursive: true })
        await writeFile(source, skillContent)
      }
    }

    await execFileAsync(
      process.execPath,
      [
        'scripts/build-first-party-modules.mjs',
        '--module',
        moduleId,
        '--output-dir',
        artifactDir,
        ...(layout ? ['--layout', layout] : []),
      ],
      { cwd: repositoryRoot },
    )
    return {
      artifactDir,
      skillContent,
      cleanup: async () => {
        await rm(root, { recursive: true, force: true })
        await rm(moduleDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    await rm(moduleDir, { recursive: true, force: true })
    throw error
  }
}

async function buildFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'learning-module-build-'))
  const artifactDir = path.join(root, 'artifact')
  const metafilePath = path.join(root, 'metafile.json')
  await execFileAsync(
    process.execPath,
    [
      'scripts/build-first-party-modules.mjs',
      '--module',
      'learning',
      '--output-dir',
      artifactDir,
      '--metafile-output',
      metafilePath,
    ],
    { cwd: repositoryRoot },
  )
  const manifestBytes = await readFile(path.join(artifactDir, 'module.json'))
  return {
    artifactDir,
    manifestSha256: hash(manifestBytes),
    metafilePath,
    root,
  }
}

function extractWorkerSource(entrySource) {
  const context = vm.createContext({})
  assert.throws(
    () => new vm.Script(entrySource).runInContext(context),
    /YOLO module host runtime v1 is unavailable/,
  )
  return vm.runInContext(
    `globalThis[Symbol.for(${JSON.stringify(workerSymbol)})]`,
    context,
  )
}

function runWorker(source) {
  let listener
  const responses = []
  const self = {
    location: { href: 'blob:learning-anki-worker' },
    addEventListener(type, next) {
      if (type === 'message') listener = next
    },
    postMessage(message, transfer) {
      if (typeof message === 'object') responses.push({ message, transfer })
    },
  }
  const context = vm.createContext({
    ArrayBuffer,
    Blob,
    Map,
    Promise,
    Set,
    SharedArrayBuffer,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    URL,
    clearTimeout,
    console,
    crypto: globalThis.crypto,
    self,
    setTimeout,
  })
  new vm.Script(source).runInContext(context)
  assert.equal(typeof listener, 'function')
  return {
    responses,
    send(data) {
      listener({ data })
    },
  }
}

async function waitForResponse(responses, id) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = responses.find(({ message }) => message.id === id)
    if (response) return response.message
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.fail(`Worker did not respond to request ${String(id)}`)
}

/** Lists every file under `directory` as a sorted, POSIX-relative path. */
async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(
        ...(await listFiles(path.join(directory, entry.name), relative)),
      )
      continue
    }
    files.push(relative)
  }
  return files.sort()
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
