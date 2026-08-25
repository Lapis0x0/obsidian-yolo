import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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
const whiteboardRoot = path.join(repositoryRoot, 'modules', 'whiteboard')
const sourceRoot = path.join(whiteboardRoot, 'src')
const forbiddenSourceRoots = [
  path.join(repositoryRoot, 'src', 'core'),
  path.join(repositoryRoot, 'src', 'components'),
]

test('declares exactly the Whiteboard production source dependencies', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(whiteboardRoot, 'package.json'), 'utf8'),
  )
  const imports = await readProductionImports()
  const packages = [
    ...new Set(
      imports
        .map(({ specifier }) => packageName(specifier))
        .filter((name) => name !== null),
    ),
  ].sort()

  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}).sort(), packages)
})

test('keeps Whiteboard production imports behind the module boundary', async () => {
  const imports = await readProductionImports()
  for (const { filePath, statement, specifier } of imports) {
    const relativePath = path.relative(repositoryRoot, filePath)
    assert.notEqual(specifier, 'obsidian', `${relativePath} imports obsidian`)
    assert.doesNotMatch(
      statement,
      /\bYoloPlugin\b/,
      `${relativePath} imports YoloPlugin`,
    )

    const normalizedSpecifier = specifier.replaceAll('\\', '/')
    assert.doesNotMatch(
      normalizedSpecifier,
      /(^|\/)src\/(core|components)(\/|$)/,
      `${relativePath} imports ${specifier}`,
    )
    if (specifier.startsWith('.')) {
      const resolvedImport = path.resolve(path.dirname(filePath), specifier)
      assert.equal(
        forbiddenSourceRoots.some(
          (root) =>
            resolvedImport === root ||
            resolvedImport.startsWith(`${root}${path.sep}`),
        ),
        false,
        `${relativePath} imports ${specifier}`,
      )
    }
  }
})

test('the domain layer stays dependency-free (no imports outside ./domain)', async () => {
  const domainRoot = path.join(sourceRoot, 'domain')
  const imports = await readImports(domainRoot)
  for (const { filePath, specifier } of imports) {
    assert.ok(
      specifier.startsWith('.'),
      `${path.relative(repositoryRoot, filePath)} imports non-relative specifier "${specifier}"`,
    )
    const resolvedImport = path.resolve(path.dirname(filePath), specifier)
    assert.ok(
      resolvedImport === domainRoot || resolvedImport.startsWith(`${domainRoot}${path.sep}`),
      `${path.relative(repositoryRoot, filePath)} imports outside domain/: ${specifier}`,
    )
  }
})

test('keeps Core out of the Whiteboard entry metafile', async () => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), 'whiteboard-module-boundary-'),
  )
  const artifactDir = path.join(fixtureRoot, 'artifact')
  const metafilePath = path.join(fixtureRoot, 'metafile.json')
  try {
    await execFileAsync(
      process.execPath,
      [
        'scripts/build-first-party-modules.mjs',
        '--module',
        'whiteboard',
        '--output-dir',
        artifactDir,
        '--metafile-output',
        metafilePath,
      ],
      { cwd: repositoryRoot },
    )
    const metafile = JSON.parse(await readFile(metafilePath, 'utf8'))
    assert.deepEqual(metafile.entryImports, [])
    assert.equal(
      metafile.inputs.some((input) =>
        /(^|\/)src\/core\//.test(input.replaceAll('\\', '/')),
      ),
      false,
    )
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('Core source has no dependency on the Whiteboard module source tree', async () => {
  const imports = await readImports(path.join(repositoryRoot, 'src'))
  for (const { filePath, specifier } of imports) {
    assert.doesNotMatch(
      specifier.replaceAll('\\', '/'),
      /(?:^|\/)modules\/whiteboard\/src(?:\/|$)/,
      `${path.relative(repositoryRoot, filePath)} imports ${specifier}`,
    )
  }
})

async function readProductionImports() {
  return readImports(sourceRoot)
}

async function readImports(root) {
  const imports = []
  for (const filePath of await listSourceFiles(root)) {
    if (/\.(?:test|fixture)\.[cm]?[jt]sx?$/.test(filePath)) continue
    const source = await readFile(filePath, 'utf8')
    const importPattern =
      /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    for (const match of source.matchAll(importPattern)) {
      imports.push({
        filePath,
        specifier: match[1] ?? match[2],
        statement: match[0],
      })
    }
  }
  return imports
}

async function listSourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listSourceFiles(entryPath)))
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(entryPath)
  }
  return files
}

function packageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null
  if (specifier.startsWith('node:')) return null
  const [scope, name] = specifier.split('/')
  return scope.startsWith('@') ? `${scope}/${name}` : scope
}
