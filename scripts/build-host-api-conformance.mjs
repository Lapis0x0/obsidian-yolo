import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import esbuild from 'esbuild'

const moduleId = 'host-api-conformance'
const version = '1.0.0'
const sourceDir = path.resolve('modules', moduleId, 'src')
const artifactDir = path.resolve('modules', moduleId, version)
const entryPath = path.join(artifactDir, 'entry.js')
const runtimeSymbol = 'yolo.module.host-runtime.v1'

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

const entry = await readFile(entryPath)
const manifest = {
  id: moduleId,
  version,
  entry: {
    path: 'entry.js',
    byteSize: entry.byteLength,
    sha256: createHash('sha256').update(entry).digest('hex'),
  },
}
await writeFile(
  path.join(artifactDir, 'module.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
)
