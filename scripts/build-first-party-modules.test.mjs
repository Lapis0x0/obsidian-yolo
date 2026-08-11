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

test('module.config.json rejects a dataFiles entry that is not a flat file name', async () => {
  const moduleId = 'zz-datafiles-nested-fixture'
  await assert.rejects(
    buildDataFilesFixture(moduleId, {
      dataFiles: ['nested/skill.md'],
      skipWritingSkillFile: true,
    }),
    /flat file name/,
  )
  await rm(path.join(repositoryRoot, 'modules', moduleId), {
    recursive: true,
    force: true,
  })
})

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
  { dataFiles, skipWritingSkillFile = false },
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
        await writeFile(path.join(moduleDir, 'src', fileName), skillContent)
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

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
