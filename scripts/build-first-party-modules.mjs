import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import esbuild from 'esbuild'

const runtimeSymbol = 'yolo.module.host-runtime.v1'
const hostApi = '^1.0.0'
const artifactPlatforms = ['desktop', 'mobile']
const moduleDefinitions = [
  {
    id: 'host-api-conformance',
    version: '1.0.0',
  },
  {
    id: 'learning',
    version: '0.1.0',
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
          contents: `const runtime = ${bridge}; if (!runtime) throw new Error('YOLO module host runtime v1 is unavailable'); export const Fragment = runtime.jsxRuntime.Fragment; export const jsx = runtime.jsxRuntime.jsx; export const jsxs = runtime.jsxRuntime.jsxs;`,
          loader: 'js',
        }
      }
      return {
        contents: `const runtime = ${bridge}; if (!runtime) throw new Error('YOLO module host runtime v1 is unavailable'); const React = runtime.react; export default React; export const useEffect = React.useEffect; export const useState = React.useState;`,
        loader: 'js',
      }
    })
  },
}

const buildResults = new Map()
for (const moduleDefinition of moduleDefinitions) {
  buildResults.set(moduleDefinition.id, await buildModule(moduleDefinition))
}

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

async function buildModule({ id, version, assets = [] }) {
  const sourceDir = path.resolve('modules', id, 'src')
  const artifactDir = path.resolve('modules', id, version)
  const entryPath = path.join(artifactDir, 'entry.js')
  await rm(artifactDir, { recursive: true, force: true })
  await mkdir(artifactDir, { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(sourceDir, 'index.tsx')],
    outfile: entryPath,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    sourcemap: false,
    plugins: [sharedRuntimePlugin],
    legalComments: 'none',
  })

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
  const releaseRoot = `https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-${id}-v${version}`
  const files = [entryFile, ...assetFiles].map((file) => ({
    ...file,
    url: `${releaseRoot}/${file.name}`,
    storage: 'module',
  }))
  const dataSchemas = {}
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
    manifestUrl: `${releaseRoot}/module.json`,
    manifest: manifestMetadata,
  }
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
