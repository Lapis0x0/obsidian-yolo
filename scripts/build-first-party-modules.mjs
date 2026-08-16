import { createHash } from 'node:crypto'
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import esbuild from 'esbuild'
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

import {
  assertReleaseAssetUniqueness,
  canonicalArtifactKey,
  deriveReleaseAssetName,
} from './module-release-assets.mjs'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
process.chdir(repositoryRoot)

const runtimeSymbol = 'yolo.module.host-runtime.v1'
const inlineWorkerMarker = 'yolo.module.inline-worker.v1'
const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((module) => `node:${module}`),
]
const artifactPlatforms = ['desktop', 'mobile']
const identifierPattern = /^[$A-Z_a-z][$\w]*$/
const reactExports = Object.keys(React).filter((name) =>
  identifierPattern.test(name),
)
const jsxRuntimeExports = Object.keys(jsxRuntime).filter(
  (name) => name !== 'default' && identifierPattern.test(name),
)
const officialModules = await loadOfficialModules()
const officialModuleById = new Map(
  officialModules.map((definition) => [definition.id, definition]),
)
const moduleDefinitions = [
  {
    id: 'host-api-conformance',
    version: '1.0.0',
    declarationPath: path.resolve(
      'modules',
      'host-api-conformance',
      '1.0.0',
      'module.json',
    ),
  },
  ...officialModules,
]

const options = parseOptions(process.argv.slice(2))
const selectedDefinitions = options.moduleId
  ? moduleDefinitions.filter(({ id }) => id === options.moduleId)
  : moduleDefinitions

if (options.moduleId && selectedDefinitions.length === 0) {
  throw new Error(`Unknown first-party module: ${options.moduleId}`)
}
if (options.outputDir && selectedDefinitions.length !== 1) {
  throw new Error('--output-dir requires exactly one --module')
}
if (options.releaseTag && selectedDefinitions.length !== 1) {
  throw new Error('--release-tag requires exactly one --module')
}
if (options.metafileOutput && selectedDefinitions.length !== 1) {
  throw new Error('--metafile-output requires exactly one --module')
}
if (options.layout === 'flat' && !options.outputDir) {
  throw new Error('--layout flat requires --output-dir')
}
if (options.releaseTag && options.moduleId) {
  const official = officialModuleById.get(options.moduleId)
  if (!official)
    throw new Error(`Cannot release non-product module: ${options.moduleId}`)
  const expectedTag = `${official.id}/v${official.package.version}`
  if (options.releaseTag !== expectedTag) {
    throw new Error(
      `${official.id} release tag must be ${expectedTag}, received: ${options.releaseTag}`,
    )
  }
  selectedDefinitions[0] = {
    ...selectedDefinitions[0],
    version: official.package.version,
  }
}

const sharedRuntimePlugin = {
  name: 'yolo-shared-module-runtime',
  setup(build) {
    build.onResolve({ filter: /^react$/ }, () => ({
      path: 'react',
      namespace: 'yolo-module-runtime',
    }))
    build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({
      path: 'jsx-runtime',
      namespace: 'yolo-module-runtime',
    }))
    build.onLoad({ filter: /.*/, namespace: 'yolo-module-runtime' }, (args) => {
      const bridge = `globalThis[Symbol.for(${JSON.stringify(runtimeSymbol)})]`
      if (args.path === 'jsx-runtime') {
        return {
          contents: createRuntimeShim(bridge, 'jsxRuntime', jsxRuntimeExports),
          loader: 'js',
        }
      }
      return {
        contents: createRuntimeShim(bridge, 'react', reactExports, true),
        loader: 'js',
      }
    })
  },
}

const buildResults = new Map()
for (const moduleDefinition of selectedDefinitions) {
  buildResults.set(
    moduleDefinition.id,
    await buildModule({
      ...moduleDefinition,
      artifactDir: options.outputDir,
      layout: options.layout ?? 'tree',
      releaseTag: options.releaseTag ?? moduleDefinition.releaseTag,
    }),
  )
}

if (options.metafileOutput) {
  const result = buildResults.get(selectedDefinitions[0].id)
  await writeFile(
    path.resolve(options.metafileOutput),
    `${JSON.stringify(
      {
        inputs: result.metafileInputs,
        entryImports: result.entryImports,
      },
      null,
      2,
    )}\n`,
  )
}

if (!options.moduleId) {
  await writeFile(
    path.resolve('modules', 'bundled.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        modules: moduleDefinitions
          .filter((moduleDefinition) => moduleDefinition.bundled)
          .map((moduleDefinition) => {
            const result = buildResults.get(moduleDefinition.id)
            const config = getModuleConfig(moduleDefinition.id)
            return {
              id: moduleDefinition.id,
              version: moduleDefinition.version,
              icon: config.icon,
              localizations: config.localizations,
              hostApi: result.hostApi,
              dataSchemas: result.dataSchemas,
              platforms: result.platforms,
              manifestUrl: result.manifestUrl,
              manifest: result.manifest,
            }
          }),
      },
      null,
      2,
    )}\n`,
  )
}

function getModuleConfig(moduleId) {
  const definition = officialModuleById.get(moduleId)
  if (definition) return definition.config
  throw new Error(`Module config is unavailable: ${moduleId}`)
}

async function loadOfficialModules() {
  const entries = await readdir(path.resolve('modules'), {
    withFileTypes: true,
  })
  const definitions = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const moduleDir = path.resolve('modules', entry.name)
    let config
    let packageJson
    try {
      ;[config, packageJson] = await Promise.all([
        readJson(path.join(moduleDir, 'module.config.json')),
        readJson(path.join(moduleDir, 'package.json')),
      ])
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (config.id !== entry.name) {
      throw new Error(
        `Module config id does not match directory: ${entry.name}`,
      )
    }
    const previewVersion = packageJson.yoloModule?.previewVersion
    const previewTag = packageJson.yoloModule?.previewTag
    if (
      typeof previewVersion !== 'string' ||
      previewTag !== `module-${config.id}-v${previewVersion}`
    ) {
      throw new Error(`${config.id} preview tag must match its pinned version`)
    }
    warnIfPreviewVersionIsStale(config.id, previewVersion, packageJson.version)
    const styleSource = path.join(moduleDir, 'src', 'style.css')
    const hasStyle = await access(styleSource).then(
      () => true,
      () => false,
    )
    const dataFileAssets = await resolveModuleDataFileAssets(
      config.id,
      moduleDir,
      config.dataFiles,
    )
    definitions.push({
      id: config.id,
      version: previewVersion,
      declarationPath: path.join(moduleDir, 'module.config.json'),
      releaseTag: previewTag,
      workers: packageJson.yoloModule?.workers ?? {},
      assets: [
        ...(hasStyle
          ? [{ role: 'style', source: 'style.css', path: 'style.css' }]
          : []),
        ...dataFileAssets,
      ],
      bundled: true,
      config,
      package: packageJson,
    })
  }
  return definitions.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * `module.config.json`'s optional `dataFiles: string[]` declares `role: 'data'`
 * artifacts (e.g. a skill package) that ship verbatim from
 * `modules/<id>/src/<path>` — no transform. An entry is an installed artifact
 * path, so it may be nested (`skills/coach/SKILL.md`); the flat Release asset
 * name is derived from it (see `scripts/module-release-assets.mjs`).
 */
async function resolveModuleDataFileAssets(moduleId, moduleDir, dataFiles) {
  if (dataFiles === undefined) return []
  if (!Array.isArray(dataFiles)) {
    throw new Error(`${moduleId} module.config.json dataFiles must be an array`)
  }
  const seen = new Set()
  const assets = []
  for (const filePath of dataFiles) {
    // Throws for absolute, escaping, unsafe, over-deep, or unfoldable paths.
    deriveReleaseAssetName(
      filePath,
      `${moduleId} module.config.json dataFiles entry`,
    )
    if (filePath === 'style.css') {
      throw new Error(
        `${moduleId} module.config.json dataFiles must not reuse the style.css name`,
      )
    }
    const canonical = canonicalArtifactKey(filePath)
    if (seen.has(canonical)) {
      throw new Error(
        `${moduleId} module.config.json dataFiles has a duplicate entry: ${filePath}`,
      )
    }
    seen.add(canonical)
    const dataSource = path.join(moduleDir, 'src', filePath)
    const exists = await access(dataSource).then(
      () => true,
      () => false,
    )
    if (!exists) {
      throw new Error(
        `${moduleId} declares dataFiles entry missing from src/: ${filePath}`,
      )
    }
    assets.push({ role: 'data', source: filePath, path: filePath })
  }
  return assets
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

// The dev-only local install channel (src/core/modules/devModuleCatalogSource.ts)
// only ever offers yoloModule.previewVersion as an install candidate when it
// resolves higher than the currently active module version. If previewVersion
// regresses to or below the published package.json version (typically because
// it was not bumped after a release), the bundled preview silently stops being
// installable in dev vaults. Warn loudly instead of failing the build: the
// release flow can legitimately pass through this state for a moment (e.g.
// right after bumping package.json for a release, before previewVersion is
// bumped past it).
function warnIfPreviewVersionIsStale(moduleId, previewVersion, packageVersion) {
  if (typeof packageVersion !== 'string') return
  if (isSemverHigher(previewVersion, packageVersion)) return
  console.warn(
    [
      '',
      '!'.repeat(72),
      `WARNING: ${moduleId} yoloModule.previewVersion "${previewVersion}" is not`,
      `higher than package.json version "${packageVersion}".`,
      'The dev-only local install channel will not surface this build as an',
      'install candidate until previewVersion/previewTag are bumped past the',
      'published release version.',
      '!'.repeat(72),
      '',
    ].join('\n'),
  )
}

function semverPrecedence(value) {
  const dashIndex = value.indexOf('-')
  const core = dashIndex === -1 ? value : value.slice(0, dashIndex)
  return {
    core: core.split('.').map((part) => Number.parseInt(part, 10)),
    hasPrerelease: dashIndex !== -1,
  }
}

/** True when `candidate` outranks `baseline` under semver precedence rules. */
function isSemverHigher(candidate, baseline) {
  const left = semverPrecedence(candidate)
  const right = semverPrecedence(baseline)
  const length = Math.max(left.core.length, right.core.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (left.core[index] ?? 0) - (right.core[index] ?? 0)
    if (Number.isNaN(diff)) return false
    if (diff !== 0) return diff > 0
  }
  if (left.hasPrerelease === right.hasPrerelease) return false
  // A release outranks a prerelease sharing the same core version.
  return !left.hasPrerelease
}

async function buildModule({
  id,
  version,
  assets = [],
  artifactDir: outputDir,
  declarationPath,
  layout = 'tree',
  releaseTag,
  workers = {},
}) {
  const declaration = JSON.parse(await readFile(declarationPath, 'utf8'))
  if (
    declaration.id !== id ||
    typeof declaration.hostApi !== 'string' ||
    !declaration.dataSchemas ||
    typeof declaration.dataSchemas !== 'object' ||
    Array.isArray(declaration.dataSchemas)
  ) {
    throw new Error(`Invalid compatibility declaration for module: ${id}`)
  }
  const { hostApi, dataSchemas } = declaration
  const platforms = declaration.platforms ?? artifactPlatforms
  if (
    !Array.isArray(platforms) ||
    platforms.length === 0 ||
    platforms.some((platform) => !artifactPlatforms.includes(platform))
  ) {
    throw new Error(`Invalid platform declaration for module: ${id}`)
  }
  const sourceDir = path.resolve('modules', id, 'src')
  const artifactDir = outputDir
    ? path.resolve(outputDir)
    : path.resolve('modules', id, version)
  const entryPath = path.join(artifactDir, 'entry.js')
  await rm(artifactDir, { recursive: true, force: true })
  await mkdir(artifactDir, { recursive: true })
  const inlineWorkers = await buildInlineWorkers(id, sourceDir, workers)
  const entryResult = await esbuild.build({
    entryPoints: [path.join(sourceDir, 'index.tsx')],
    outfile: entryPath,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    supported: { 'template-literal': false },
    minify: true,
    sourcemap: false,
    plugins: [sharedRuntimePlugin],
    legalComments: 'none',
    metafile: true,
    banner: {
      js: inlineWorkers
        .map(
          ({ name, source }) =>
            `globalThis[Symbol.for(${JSON.stringify(`${inlineWorkerMarker}:${id}:${name}`)})]=${JSON.stringify(source)};`,
        )
        .join(''),
    },
  })
  assertModuleBoundary(id, entryResult.metafile)

  // `tree` writes every artifact at its installed path, which is what the Host
  // reads from `<plugin>/modules/<id>/<version>/`. `flat` writes it at its
  // Release asset name, which is the only shape a GitHub Release can hold.
  const plan = [{ role: 'entry', path: 'entry.js' }, ...assets].map((asset) => {
    const name = deriveReleaseAssetName(asset.path, `${id} artifact file path`)
    return { ...asset, name, output: layout === 'flat' ? name : asset.path }
  })
  assertReleaseAssetUniqueness(plan, id)

  await Promise.all(
    plan.map(async (asset) => {
      if (asset.role === 'entry') return
      const outfile = path.join(artifactDir, asset.output)
      await mkdir(path.dirname(outfile), { recursive: true })
      if (asset.role === 'style') {
        await esbuild.build({
          entryPoints: [path.join(sourceDir, asset.source)],
          outfile,
          bundle: true,
          minify: true,
          legalComments: 'none',
        })
        return
      }
      if (asset.role === 'data') {
        // Ships verbatim — no bundling/transform for a data artifact (e.g. a
        // module chat mode skill package).
        await copyFile(path.join(sourceDir, asset.source), outfile)
        return
      }
      throw new Error(`Unsupported module asset role: ${asset.role}`)
    }),
  )

  const tag = releaseTag ?? `module-${id}-v${version}`
  const releaseRoot = `https://github.com/Lapis0x0/obsidian-yolo/releases/download/${encodeURIComponent(tag)}`
  const files = await Promise.all(
    plan.map(async (asset) => ({
      ...(await describeArtifactFile(artifactDir, asset)),
      url: `${releaseRoot}/${encodeURIComponent(asset.name)}`,
      storage: 'module',
    })),
  )
  const entryFile = files.find((file) => file.role === 'entry')
  const manifest = {
    schemaVersion: 1,
    id,
    version,
    hostApi,
    dataSchemas,
    variants: platforms.map((platform) => ({
      platform,
      entry: entryFile.path,
      files,
    })),
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const manifestMetadata = {
    byteSize: manifestBytes.byteLength,
    sha256: createHash('sha256').update(manifestBytes).digest('hex'),
  }
  await writeFile(path.join(artifactDir, 'module.json'), manifestBytes)
  return {
    hostApi,
    dataSchemas,
    platforms,
    entryImports: Object.values(entryResult.metafile.outputs).flatMap(
      ({ imports }) => imports,
    ),
    metafileInputs: [
      ...Object.keys(entryResult.metafile.inputs),
      ...inlineWorkers.flatMap(({ metafileInputs }) => metafileInputs),
    ].sort(),
    manifestUrl: `${releaseRoot}/module.json`,
    manifest: manifestMetadata,
  }
}

async function buildInlineWorkers(moduleId, sourceDir, workers) {
  if (!workers || typeof workers !== 'object' || Array.isArray(workers)) {
    throw new Error(`Invalid worker declarations for module: ${moduleId}`)
  }
  return Promise.all(
    Object.entries(workers).map(async ([name, relativeEntry]) => {
      if (
        !name ||
        typeof relativeEntry !== 'string' ||
        path.isAbsolute(relativeEntry) ||
        relativeEntry.split(/[\\/]/).includes('..')
      ) {
        throw new Error(`Invalid worker declaration for module: ${moduleId}`)
      }
      const result = await esbuild.build({
        entryPoints: [path.resolve(sourceDir, relativeEntry)],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        external: nodeBuiltins,
        minify: true,
        legalComments: 'none',
        metafile: true,
        logLevel: 'silent',
        banner: {
          // Electron workers expose process, causing sql.js to choose its Node loader.
          js: 'const process={};',
        },
        define: {
          'process.env.NODE_ENV': JSON.stringify('production'),
        },
      })
      assertModuleBoundary(moduleId, result.metafile)
      const source = result.outputFiles[0]?.text ?? ''
      if (!source.trim()) {
        throw new Error(`Empty worker bundle for module: ${moduleId}/${name}`)
      }
      return {
        name,
        source,
        metafileInputs: Object.keys(result.metafile.inputs),
      }
    }),
  )
}

function assertModuleBoundary(moduleId, metafile) {
  const coreRoot = `${path.resolve('src', 'core')}${path.sep}`
  const coreInput = Object.keys(metafile.inputs).find((input) =>
    path.resolve(input).startsWith(coreRoot),
  )
  if (coreInput) {
    throw new Error(
      `Module ${moduleId} bundle must not import Core source: ${coreInput}`,
    )
  }
}

function createRuntimeShim(
  bridge,
  runtimeKey,
  exportNames,
  hasDefault = false,
) {
  const namespace = runtimeKey === 'react' ? 'React' : 'runtimeModule'
  return [
    `const runtime=${bridge}`,
    `if(!runtime)throw new Error('YOLO module host runtime v1 is unavailable')`,
    `const ${namespace}=runtime[${JSON.stringify(runtimeKey)}]`,
    `if(!${namespace})throw new Error('YOLO module host ${runtimeKey} runtime is unavailable')`,
    hasDefault ? `export default ${namespace}` : '',
    ...exportNames.map(
      (name) => `export const ${name}=${namespace}[${JSON.stringify(name)}]`,
    ),
  ]
    .filter(Boolean)
    .join(';')
}

function parseOptions(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (
      option !== '--module' &&
      option !== '--output-dir' &&
      option !== '--release-tag' &&
      option !== '--metafile-output' &&
      option !== '--layout'
    ) {
      throw new Error(`Unknown option: ${option}`)
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${option}`)
    }
    const key = {
      '--module': 'moduleId',
      '--output-dir': 'outputDir',
      '--release-tag': 'releaseTag',
      '--metafile-output': 'metafileOutput',
      '--layout': 'layout',
    }[option]
    options[key] = value
    index += 1
  }
  if (
    options.layout &&
    options.layout !== 'tree' &&
    options.layout !== 'flat'
  ) {
    throw new Error(`--layout must be tree or flat: ${options.layout}`)
  }
  return options
}

async function describeArtifactFile(artifactDir, asset) {
  const bytes = await readFile(path.join(artifactDir, asset.output))
  return {
    role: asset.role,
    name: asset.name,
    path: asset.path,
    byteSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
