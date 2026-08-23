import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import esbuild from 'esbuild'

import { isValidRuntimeComponentAssetName } from './runtimeComponentAssetName.mjs'
import { resolveRuntimeComponentAssetSource } from './runtimeComponentAssetSources.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

const production = process.argv.includes('--production')
const check = process.argv.includes('--check')
const componentRoot = path.resolve('runtime-components')
const allowedIds = new Set([
  'tokenizer',
  'pdf-engine',
  'bash-engine',
  'embedding-engine',
])
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

const entries = await readdir(componentRoot, { withFileTypes: true })
const components = []
for (const entry of entries.sort((left, right) =>
  left.name.localeCompare(right.name),
)) {
  if (!entry.isDirectory()) continue
  const configPath = path.join(
    componentRoot,
    entry.name,
    'component.config.json',
  )
  let config
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') continue
    throw error
  }
  validateConfig(config, entry.name)
  const componentDir = path.join(componentRoot, entry.name)
  const outputPath = path.join(componentDir, 'dist', 'entry.js')
  await mkdir(path.dirname(outputPath), { recursive: true })
  const workerMetafiles = []
  const result = await esbuild.build({
    entryPoints: [path.join(componentDir, 'src', 'entry.ts')],
    outfile: outputPath,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    minify: production,
    sourcemap: false,
    metafile: true,
    write: !check,
    define: {
      'process.env.NODE_ENV': JSON.stringify(
        production ? 'production' : 'development',
      ),
    },
    plugins: componentPlugins(entry.name, workerMetafiles),
    logLevel: 'silent',
  })
  verifyBoundary(entry.name, result.metafile)
  for (const workerMetafile of workerMetafiles) {
    verifyBoundary(entry.name, workerMetafile)
  }
  const output = result.outputFiles?.[0]?.contents
  const bytes = output ?? new Uint8Array(await readFile(outputPath))
  const assets = await syncComponentAssets(entry.name, componentDir, config)
  const descriptor = Object.freeze({
    id: config.id,
    platforms: Object.freeze([...config.platforms]),
    nameKey: config.nameKey,
    descriptionKey: config.descriptionKey,
    impactKey: config.impactKey,
    entry: `runtime-components/${config.id}/${config.entry}`,
    byteSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(assets.length > 0 ? { assets } : {}),
  })
  components.push(descriptor)
  const metafileJson = `${JSON.stringify(result.metafile, null, 2)}\n`
  // Combined worker-bundle metafile(s) — captured only for components whose
  // esbuild plugin inlines a nested worker build (currently embedding-engine
  // only). Checked in `--check` mode and written otherwise, mirroring
  // `meta.json`, so `verify-runtime-component-boundaries.mjs` has a stable
  // artifact to inspect the worker's own dependency closure through (the
  // worker's imports never appear in the outer `meta.json` since the worker
  // source is inlined as a string, not bundled directly into entry.js).
  const workerMetafileJson =
    workerMetafiles.length > 0
      ? `${JSON.stringify(workerMetafiles[0], null, 2)}\n`
      : null
  if (check) {
    const [installedEntry, installedMetafile] = await Promise.all([
      readFile(outputPath),
      readFile(path.join(componentDir, 'dist', 'meta.json'), 'utf8'),
    ])
    if (
      !sameBytes(installedEntry, bytes) ||
      installedMetafile !== metafileJson
    ) {
      throw new Error(
        `Runtime component source and dist are not synchronized: ${entry.name}`,
      )
    }
    if (workerMetafileJson !== null) {
      const installedWorkerMetafile = await readFile(
        path.join(componentDir, 'dist', 'worker-meta.json'),
        'utf8',
      )
      if (installedWorkerMetafile !== workerMetafileJson) {
        throw new Error(
          `Runtime component worker source and dist are not synchronized: ${entry.name}`,
        )
      }
    }
  } else {
    await writeFile(path.join(componentDir, 'dist', 'meta.json'), metafileJson)
    if (workerMetafileJson !== null) {
      await writeFile(
        path.join(componentDir, 'dist', 'worker-meta.json'),
        workerMetafileJson,
      )
    }
  }
}

/**
 * Copies a component's declared `assets` (see `component.config.json`'s
 * optional `assets` array) from their build-time source into
 * `dist/assets/<name>`, then hashes them for the registry descriptor.
 * `--check` mode compares against what's already on disk instead of
 * overwriting, matching how `entry.js`/`meta.json` are checked above.
 * Components with no declared assets are untouched (no `dist/assets`
 * directory is created), preserving old behavior exactly.
 *
 * `dist/assets/` is gitignored (see `.gitignore`) — a fresh checkout has no
 * local copy at all until `npm run runtime:build` has run once. `--check`
 * distinguishes that from real drift: a missing local asset gets a "run the
 * build first" error, not a synchronization-mismatch error, since there is
 * nothing to compare against yet.
 */
async function syncComponentAssets(componentId, componentDir, config) {
  const declared = config.assets ?? []
  if (declared.length === 0) return []
  const assetsDir = path.join(componentDir, 'dist', 'assets')
  const descriptors = []
  if (!check) await mkdir(assetsDir, { recursive: true })
  for (const name of declared) {
    const sourcePath = path.resolve(
      resolveRuntimeComponentAssetSource(componentId, name),
    )
    const bytes = await readFile(sourcePath)
    const destPath = path.join(assetsDir, name)
    if (check) {
      let installed
      try {
        installed = await readFile(destPath)
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw new Error(
            `Runtime component "${componentId}" has no local dist/assets/${name} — run "npm run runtime:build" first`,
          )
        }
        throw error
      }
      if (!sameBytes(installed, bytes)) {
        throw new Error(
          `Runtime component asset is not synchronized: ${componentId}/${name}`,
        )
      }
    } else {
      await writeFile(destPath, bytes)
    }
    descriptors.push({
      name,
      path: `runtime-components/${componentId}/dist/assets/${name}`,
      byteSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  const existing = await readdir(assetsDir).catch(() => [])
  const stray = existing.filter((file) => !declared.includes(file))
  if (stray.length > 0) {
    if (check) {
      throw new Error(
        `Runtime component has undeclared assets on disk: ${componentId}: ${stray.join(', ')}`,
      )
    }
    await Promise.all(
      stray.map((file) => rm(path.join(assetsDir, file), { force: true })),
    )
  }
  return descriptors
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

if (components.length !== allowedIds.size) {
  throw new Error(
    `Expected ${allowedIds.size} runtime components, found ${components.length}`,
  )
}
const registry = {
  schemaVersion: 2,
  components: components.sort((left, right) => left.id.localeCompare(right.id)),
}
const registryJson = `${JSON.stringify(registry, null, 2)}\n`
const registryPath = path.join(componentRoot, 'registry.json')
if (check) {
  const existing = await readFile(registryPath, 'utf8')
  if (existing !== registryJson) {
    throw new Error(
      'Runtime component source, dist, and registry are not synchronized',
    )
  }
} else {
  await writeFile(registryPath, registryJson)
}

function validateConfig(value, directoryName) {
  const keys = Object.keys(value)
  const hasAssets = keys.includes('assets')
  const expected = [
    'descriptionKey',
    'entry',
    'id',
    'impactKey',
    'nameKey',
    'platforms',
    'schemaVersion',
    ...(hasAssets ? ['assets'] : []),
  ].sort()
  if (JSON.stringify([...keys].sort()) !== JSON.stringify(expected)) {
    throw new Error(
      `Runtime component config has unexpected keys: ${directoryName}`,
    )
  }
  if (
    value.schemaVersion !== 2 ||
    value.id !== directoryName ||
    !allowedIds.has(value.id) ||
    value.entry !== 'dist/entry.js' ||
    !Array.isArray(value.platforms) ||
    value.platforms.length === 0 ||
    value.platforms.some(
      (platform) => platform !== 'desktop' && platform !== 'mobile',
    ) ||
    new Set(value.platforms).size !== value.platforms.length ||
    typeof value.nameKey !== 'string' ||
    typeof value.descriptionKey !== 'string' ||
    typeof value.impactKey !== 'string'
  ) {
    throw new Error(`Runtime component config is invalid: ${directoryName}`)
  }
  if (
    hasAssets &&
    (!Array.isArray(value.assets) ||
      value.assets.length === 0 ||
      value.assets.some((name) => !isValidRuntimeComponentAssetName(name)) ||
      new Set(value.assets).size !== value.assets.length)
  ) {
    throw new Error(
      `Runtime component config has an invalid assets list: ${directoryName}`,
    )
  }
}

function componentPlugins(componentId, workerMetafiles) {
  const plugins = []
  if (componentId === 'bash-engine') {
    plugins.push(bashEngineZlibStubPlugin())
  }
  if (componentId === 'pdf-engine') {
    plugins.push({
      name: 'runtime-pdf-worker',
      setup(build) {
        build.onResolve({ filter: /^virtual:pdfjs-worker-script$/ }, () => ({
          path: 'pdf-worker',
          namespace: 'runtime-worker',
        }))
        build.onLoad(
          { filter: /^pdf-worker$/, namespace: 'runtime-worker' },
          async () => ({
            contents: `export default ${JSON.stringify(
              await readFile(
                path.resolve(
                  'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs',
                ),
                'utf8',
              ),
            )}`,
            loader: 'js',
          }),
        )
      },
    })
  }
  if (componentId === 'embedding-engine') {
    plugins.push(embeddingWorkerPlugin(workerMetafiles))
  }
  return plugins
}

/**
 * Bundles `worker.ts` (Transformers.js + onnxruntime-web + our RPC glue)
 * into a single self-contained classic-worker script via a *nested* esbuild
 * build, then inlines the result as a string constant so entry.ts can spin
 * it up with `new Worker(URL.createObjectURL(new Blob([source])))` — the
 * same "virtual:*-worker-script" pattern pdf-engine uses for pdf.worker.js,
 * except pdf-engine inlines an already-prebuilt file verbatim while this one
 * needs its own bundling pass (worker.ts has real, unresolved `import`s).
 *
 * The `onnxruntime-web-use-extern-wasm` condition steers onnxruntime-web's
 * "exports" map to the variant that loads its .wasm binaries externally
 * (`ort.min.mjs`, via `wasmPaths`) instead of the default variant that
 * inlines them as base64 (`ort.bundle.min.mjs`) — the latter would balloon
 * this component by another ~15MB of base64 text and defeat the whole
 * point of shipping wasm as separate, cacheable assets.
 */
function embeddingWorkerPlugin(workerMetafiles) {
  return {
    name: 'runtime-embedding-worker',
    setup(build) {
      build.onResolve({ filter: /^virtual:embedding-worker-script$/ }, () => ({
        path: 'embedding-worker',
        namespace: 'runtime-worker',
      }))
      build.onLoad(
        { filter: /^embedding-worker$/, namespace: 'runtime-worker' },
        async () => {
          const result = await esbuild.build({
            entryPoints: [
              path.join(componentRoot, 'embedding-engine', 'src', 'worker.ts'),
            ],
            bundle: true,
            platform: 'browser',
            format: 'iife',
            target: 'es2020',
            minify: production,
            sourcemap: false,
            metafile: true,
            write: false,
            conditions: ['onnxruntime-web-use-extern-wasm'],
            define: {
              'process.env.NODE_ENV': JSON.stringify(
                production ? 'production' : 'development',
              ),
            },
            logLevel: 'silent',
          })
          workerMetafiles.push(result.metafile)
          const source = result.outputFiles[0].text
          return {
            contents: `export default ${JSON.stringify(source)}`,
            loader: 'js',
          }
        },
      )
    },
  }
}

function bashEngineZlibStubPlugin() {
  return {
    name: 'runtime-bash-engine-zlib-stub',
    setup(build) {
      build.onResolve({ filter: /^node:zlib$/ }, () => ({
        path: 'bash-engine-zlib-stub',
        namespace: 'runtime-stub',
      }))
      build.onLoad(
        { filter: /^bash-engine-zlib-stub$/, namespace: 'runtime-stub' },
        () => ({
          contents: [
            'export function gzipSync() {',
            "  throw new Error('gzip is not supported in this environment')",
            '}',
            'export function gunzipSync() {',
            "  throw new Error('gunzip is not supported in this environment')",
            '}',
            'export const constants = {}',
            '',
          ].join('\n'),
          loader: 'js',
        }),
      )
    },
  }
}

function verifyBoundary(componentId, metafile) {
  const componentPrefix = `runtime-components/${componentId}/`
  for (const [input, data] of Object.entries(metafile.inputs)) {
    const normalized = input.replaceAll('\\', '/')
    if (
      normalized.startsWith('src/') ||
      normalized.startsWith('modules/') ||
      normalized.includes('/obsidian/') ||
      normalized.endsWith('/obsidian') ||
      normalized === 'obsidian' ||
      [...nodeBuiltins].some(
        (builtin) =>
          normalized === builtin || normalized.endsWith(`/${builtin}`),
      )
    ) {
      throw new Error(
        `Runtime component ${componentId} crosses a forbidden build boundary: ${input}`,
      )
    }
    for (const imported of data.imports ?? []) {
      if (nodeBuiltins.has(imported.path) || imported.path === 'obsidian') {
        throw new Error(
          `Runtime component ${componentId} imports forbidden dependency ${imported.path}`,
        )
      }
      if (imported.kind === 'dynamic-import' && !imported.external) {
        throw new Error(
          `Runtime component ${componentId} contains an unapproved dynamic import in ${input}: ${imported.path}`,
        )
      }
    }
    if (
      normalized.startsWith('runtime-components/') &&
      !normalized.startsWith(componentPrefix) &&
      normalized !== 'runtime-components/sdk.d.ts'
    ) {
      throw new Error(
        `Runtime component ${componentId} imports another component: ${input}`,
      )
    }
  }
  for (const output of Object.values(metafile.outputs)) {
    if ((output.imports ?? []).length > 0) {
      throw new Error(
        `Runtime component ${componentId} output is not standalone`,
      )
    }
  }
}
