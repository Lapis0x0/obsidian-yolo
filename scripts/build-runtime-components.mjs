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
  'claude-agent-sdk',
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
  const usesNode = config.node === true
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
      ...(usesNode ? { 'import.meta.url': 'import_meta_url' } : {}),
    },
    ...(usesNode ? nodeComponentBuildOptions() : {}),
    plugins: componentPlugins(entry.name, workerMetafiles),
    logLevel: 'silent',
  })
  verifyBoundary(entry.name, result.metafile, usesNode)
  for (const workerMetafile of workerMetafiles) {
    verifyBoundary(entry.name, workerMetafile, usesNode)
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
  const hasNode = keys.includes('node')
  const expected = [
    'descriptionKey',
    'entry',
    'id',
    'impactKey',
    'nameKey',
    'platforms',
    'schemaVersion',
    ...(hasAssets ? ['assets'] : []),
    ...(hasNode ? ['node'] : []),
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
  // Node builtins only exist in Obsidian's desktop renderer, so a component
  // that uses them must never be offered to mobile.
  if (
    hasNode &&
    (value.node !== true ||
      JSON.stringify(value.platforms) !== JSON.stringify(['desktop']))
  ) {
    throw new Error(
      `Runtime component config may only declare "node": true for a desktop-only component: ${directoryName}`,
    )
  }
}

/**
 * Build options for a desktop-only component that declares `"node": true`.
 * Node builtins stay external: esbuild turns each import of one into a call
 * to its `__require` helper, which the component resolves at run time through
 * the global `require` of Obsidian's desktop renderer (the component executes
 * in the host's realm via a Blob `<script>`). Dynamic `import("node:fs")` is
 * lowered to the same `require` instead of a native `import()` that Chromium
 * would try to fetch, and `import.meta.url`, which has no meaning in a Blob
 * script, becomes a file URL from the shim — the same treatment
 * `esbuild.config.mjs` gives the host bundle.
 */
function nodeComponentBuildOptions() {
  return {
    external: [...nodeBuiltins],
    inject: [path.resolve('scripts/runtimeComponentImportMetaUrlShim.mjs')],
    supported: { 'dynamic-import': false },
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
        build.onResolve({ filter: /^virtual:pdfjs-binary-data$/ }, () => ({
          path: 'pdf-binary-data',
          namespace: 'runtime-worker',
        }))
        build.onLoad(
          { filter: /^pdf-binary-data$/, namespace: 'runtime-worker' },
          async () => ({
            contents: `export default ${JSON.stringify(
              await readPdfBinaryData(),
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
 * The files pdf.js requests through its `StandardFontDataFactory` and
 * `WasmFactory` (see pdf-engine's `InlineBinaryDataFactory`), inlined as
 * base64 so the component never fetches anything at runtime. Keyed by kind.
 * Stored uncompressed on purpose: registry.json pins this artifact's sha256,
 * and CI rebuilds it on a different Node/zlib/CPU, where compressed bytes
 * are not guaranteed to be identical.
 * - Standard fonts: with pdf.js's browser default `useSystemFonts`, a
 *   non-embedded standard font resolves to a system font, and only Symbol
 *   and ZapfDingbats are ever requested, so those are the only two shipped.
 * - `openjpeg.wasm`: pdf.js 5.4's only JPEG 2000 decoder once its
 *   `openjpeg_nowasm_fallback.js` is left out (every supported WebView has
 *   WebAssembly); without it JPX images render blank.
 * - `jbig2.wasm`: pdf.js 5.4's default JBIG2 decoder; its JS decoder is only
 *   a fallback after the wasm one fails, with a warning per image. CCITT is
 *   decoded in JS and needs nothing. `qcms_bg.wasm` is left out: pdf.js only
 *   uses it with `useWorkerFetch`.
 */
async function readPdfBinaryData() {
  const sources = {
    standardFontData: [
      'standard_fonts/FoxitDingbats.pfb',
      'standard_fonts/FoxitSymbol.pfb',
    ],
    wasm: ['wasm/jbig2.wasm', 'wasm/openjpeg.wasm'],
  }
  const data = {}
  for (const [kind, files] of Object.entries(sources)) {
    data[kind] = {}
    for (const file of files) {
      const bytes = await readFile(
        path.resolve('node_modules/pdfjs-dist', file),
      )
      data[kind][path.basename(file)] = bytes.toString('base64')
    }
  }
  return data
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

/**
 * `usesNode` is true only for a component whose config declares
 * `"node": true` (validated to be desktop-only). It lifts the Node-builtin
 * ban and lets the output reference builtins as externals; every other rule
 * applies unchanged.
 */
function verifyBoundary(componentId, metafile, usesNode) {
  const componentPrefix = `runtime-components/${componentId}/`
  for (const [input, data] of Object.entries(metafile.inputs)) {
    const normalized = input.replaceAll('\\', '/')
    if (
      normalized.startsWith('src/') ||
      normalized.startsWith('modules/') ||
      normalized.includes('/obsidian/') ||
      normalized.endsWith('/obsidian') ||
      normalized === 'obsidian' ||
      (!usesNode &&
        [...nodeBuiltins].some(
          (builtin) =>
            normalized === builtin || normalized.endsWith(`/${builtin}`),
        ))
    ) {
      throw new Error(
        `Runtime component ${componentId} crosses a forbidden build boundary: ${input}`,
      )
    }
    for (const imported of data.imports ?? []) {
      if (
        (!usesNode && nodeBuiltins.has(imported.path)) ||
        imported.path === 'obsidian'
      ) {
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
    const imports = (output.imports ?? []).filter(
      (imported) =>
        !(usesNode && imported.external && nodeBuiltins.has(imported.path)),
    )
    if (imports.length > 0) {
      throw new Error(
        `Runtime component ${componentId} output is not standalone`,
      )
    }
  }
}
