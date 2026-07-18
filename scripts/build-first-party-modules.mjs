import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import esbuild from 'esbuild'
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

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
const learningPackage = JSON.parse(
  await readFile(path.resolve('modules', 'learning', 'package.json'), 'utf8'),
)
const learningPreviewVersion = learningPackage.yoloModule.previewVersion
const learningPreviewTag = learningPackage.yoloModule.previewTag
const learningReleaseTag = `${learningPackage.yoloModule.releaseTagPrefix}${learningPackage.version}`
if (learningPreviewTag !== `module-learning-v${learningPreviewVersion}`) {
  throw new Error('Learning preview tag must match its pinned preview version')
}
if (learningPackage.yoloModule.releaseTagPrefix !== 'learning/v') {
  throw new Error('Learning release tag prefix must remain learning/v')
}
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
  {
    id: 'learning',
    version: learningPreviewVersion,
    declarationPath: path.resolve(
      'modules',
      'learning',
      learningPreviewVersion,
      'module.json',
    ),
    releaseTag: learningPreviewTag,
    workers: learningPackage.yoloModule.workers,
    assets: [
      {
        role: 'style',
        source: 'style.css',
        path: 'style.css',
      },
    ],
    bundled: {
      name: 'Learning module preview',
      description:
        'Read-only module boundary preview for existing Learning data.',
    },
  },
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
if (options.releaseTag && options.moduleId === 'learning') {
  if (options.releaseTag !== learningReleaseTag) {
    throw new Error(
      `Learning release tag must be ${learningReleaseTag}, received: ${options.releaseTag}`,
    )
  }
  selectedDefinitions[0] = {
    ...selectedDefinitions[0],
    version: learningPackage.version,
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
            return {
              id: moduleDefinition.id,
              version: moduleDefinition.version,
              name: moduleDefinition.bundled.name,
              description: moduleDefinition.bundled.description,
              hostApi: result.hostApi,
              dataSchemas: result.dataSchemas,
              platforms: artifactPlatforms,
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

async function buildModule({
  id,
  version,
  assets = [],
  artifactDir: outputDir,
  declarationPath,
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

  await Promise.all(
    assets.map(async (asset) => {
      if (asset.role !== 'style') {
        throw new Error(`Unsupported module asset role: ${asset.role}`)
      }
      await esbuild.build({
        entryPoints: [path.join(sourceDir, asset.source)],
        outfile: path.join(artifactDir, asset.path),
        bundle: true,
        minify: true,
        legalComments: 'none',
      })
    }),
  )

  const entryFile = await describeArtifactFile(artifactDir, 'entry', 'entry.js')
  const assetFiles = await Promise.all(
    assets.map((asset) =>
      describeArtifactFile(artifactDir, asset.role, asset.path),
    ),
  )
  const tag = releaseTag ?? `module-${id}-v${version}`
  const releaseRoot = `https://github.com/Lapis0x0/obsidian-yolo/releases/download/${encodeURIComponent(tag)}`
  const files = [entryFile, ...assetFiles].map((file) => ({
    ...file,
    url: `${releaseRoot}/${file.name}`,
    storage: 'module',
  }))
  const manifest = {
    schemaVersion: 1,
    id,
    version,
    hostApi,
    dataSchemas,
    variants: artifactPlatforms.map((platform) => ({
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
  await Promise.all(
    artifactPlatforms.map((platform) =>
      writeFile(
        path.join(
          artifactDir,
          `ready.${platform}.${manifestMetadata.sha256}.json`,
        ),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            id,
            version,
            platform,
            manifestSha256: manifestMetadata.sha256,
          },
          null,
          2,
        )}\n`,
      ),
    ),
  )
  return {
    hostApi,
    dataSchemas,
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
      option !== '--metafile-output'
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
    }[option]
    options[key] = value
    index += 1
  }
  return options
}

async function describeArtifactFile(artifactDir, role, relativePath) {
  const bytes = await readFile(path.join(artifactDir, relativePath))
  return {
    role,
    name: path.basename(relativePath),
    path: relativePath,
    byteSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
