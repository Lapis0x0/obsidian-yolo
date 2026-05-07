/**
 * Web build config for YOLO Web Runtime.
 *
 * This builds the browser-side UI bundle (web-ui/index.tsx → web-ui/index.js).
 * It follows the same patterns as esbuild.config.mjs but targets the browser.
 * Shared React imports are funneled through runtime/compat; the raw 'obsidian'
 * package is aliased to a browser shim only for the web bundle.
 */
import * as esbuild from 'esbuild'
import { copyFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const prod = process.argv[2] === 'production'
const obsidianModulePath = resolve(
  __dirname,
  'src/runtime/web/obsidianCompat.ts',
)
const sdkFetchPath = resolve(__dirname, 'src/core/llm/sdkFetch.ts')
const sdkFetchStem = sdkFetchPath.replace(/\.ts$/, '')
const browserSdkFetchPath = resolve(
  __dirname,
  'src/runtime/web/browser-stubs/sdkFetch.ts',
)
const externalCliIndexPath = resolve(
  __dirname,
  'src/core/agent/external-cli/index.ts',
)
const externalCliIndexStem = externalCliIndexPath.replace(/\.ts$/, '')
const browserExternalCliPath = resolve(
  __dirname,
  'src/runtime/web/browser-stubs/external-cli.ts',
)
const webUiDir = resolve(__dirname, 'web-ui')
const appCssSourcePath = resolve(__dirname, 'app.css')
const appCssOutputPath = resolve(webUiDir, 'app.css')
const stylesCssSourcePath = resolve(__dirname, 'styles.css')
const stylesCssOutputPath = resolve(webUiDir, 'styles.css')

function emitWebStaticAssets() {
  mkdirSync(webUiDir, { recursive: true })
  copyFileSync(appCssSourcePath, appCssOutputPath)
  copyFileSync(stylesCssSourcePath, stylesCssOutputPath)
}

const webContext = await esbuild.context({
  entryPoints: [resolve(__dirname, 'web-ui/index.tsx')],
  outfile: resolve(__dirname, 'web-ui/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020', 'chrome89', 'firefox89', 'safari14'],
  jsx: 'automatic',
  resolveExtensions: ['.tsx', '.ts', '.js', '.jsx', '.mjs'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development'),
  },
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  minify: prod,
  plugins: [
    {
      name: 'web-obsidian-mock',
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, (args) => {
          return { path: obsidianModulePath }
        })

        build.onResolve({ filter: /sdkFetch$/ }, (args) => {
          const resolvedPath = resolve(args.resolveDir, args.path)
          if (resolvedPath === sdkFetchPath || resolvedPath === sdkFetchStem) {
            return { path: browserSdkFetchPath }
          }
          return null
        })

        build.onResolve({ filter: /external-cli\/index$/ }, (args) => {
          const resolvedPath = resolve(args.resolveDir, args.path)
          if (
            resolvedPath === externalCliIndexPath ||
            resolvedPath === externalCliIndexStem
          ) {
            return { path: browserExternalCliPath }
          }
          return null
        })
      },
    },
  ],
})

if (prod) {
  await webContext.rebuild()
  emitWebStaticAssets()
  console.log('Web build complete: web-ui/index.js')
  process.exit(0)
} else {
  emitWebStaticAssets()
  await webContext.watch()
}
