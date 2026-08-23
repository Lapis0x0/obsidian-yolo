/**
 * Runtime component assets (e.g. embedding-engine's onnxruntime-web wasm
 * binaries) are gitignored build outputs — see `.gitignore` — so they can't
 * ride along inside `main.js` the way the rest of Core does, and they can't
 * be fetched from a tagged Git ref the way `dist/entry.js` can (see
 * `runtimeComponentAssetReleaseUrl` in
 * `src/core/runtime-components/runtimeComponentManifest.ts`). Core releases
 * upload them as ordinary GitHub Release attachments instead, alongside
 * `main.js`/`manifest.json`/`styles.css`/`release-note.md`.
 *
 * A Release has one flat asset namespace per tag, so each asset's filename
 * is folded to `{componentId}-{name}` to avoid two components colliding on
 * a shared asset filename (e.g. both bundling an
 * `ort-wasm-simd-threaded.wasm`). This module is the single source of truth
 * for that naming and for which assets exist at all, read straight from
 * `registry.json` — `release.yml`'s upload step and
 * `verify-core-release-assets.mjs`'s expected-name set both go through it,
 * so they can never drift from each other or from what
 * `npm run runtime:build` actually declared.
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function listRuntimeComponentReleaseAssets(root = process.cwd()) {
  const registry = JSON.parse(
    await readFile(path.join(root, 'runtime-components/registry.json'), 'utf8'),
  )
  const entries = []
  for (const descriptor of registry.components ?? []) {
    for (const asset of descriptor.assets ?? []) {
      entries.push({
        releaseName: `${descriptor.id}-${asset.name}`,
        sourcePath: path.join(
          root,
          `runtime-components/${descriptor.id}/dist/assets/${asset.name}`,
        ),
      })
    }
  }
  return entries
}

/**
 * Copies every declared runtime component asset into `destDir`, renamed to
 * its flat Release asset name — the CI step that fills `core-release/`
 * alongside `main.js`/`manifest.json`/`styles.css`/`release-note.md` before
 * `gh release upload`. Reads from `dist/assets/`, i.e. requires
 * `npm run build`/`npm run runtime:build` to have already run.
 */
export async function copyRuntimeComponentReleaseAssets(
  destDir,
  root = process.cwd(),
) {
  const entries = await listRuntimeComponentReleaseAssets(root)
  await mkdir(destDir, { recursive: true })
  await Promise.all(
    entries.map((entry) =>
      copyFile(entry.sourcePath, path.join(destDir, entry.releaseName)),
    ),
  )
  return entries
}

async function main(args) {
  const [destDir, ...extra] = args
  if (!destDir || extra.length > 0) {
    throw new Error('Usage: runtimeComponentReleaseAssets.mjs <destDir>')
  }
  const entries = await copyRuntimeComponentReleaseAssets(destDir)
  for (const entry of entries) {
    console.log(`Copied ${entry.releaseName}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
