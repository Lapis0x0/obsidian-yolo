/**
 * Runtime component artifacts — every component's `dist/entry.js` plus any
 * declared assets (e.g. embedding-engine's onnxruntime-web wasm binaries) —
 * are gitignored build outputs (see `.gitignore`), so they can't ride along
 * inside `main.js` the way the rest of Core does and there is nothing to
 * fetch from a tagged Git ref. They are published instead as attachments on
 * one permanent, append-only Release, `runtime-assets`.
 *
 * That Release is deliberately *not* versioned. The client never trusts the
 * URL: `registry.json` (which is committed, and baked into `main.js`)
 * declares every artifact's byteSize and sha256, and
 * `runtimeComponentInstaller` verifies the downloaded bytes against it
 * before anything lands on disk. The hash is the contract, so the URL only
 * has to answer "where are these bytes" — putting a Core version in it made
 * every Core release attach another byte-identical copy of artifacts that
 * change far more rarely than Core does.
 *
 * Each attachment is therefore named `{sha256}-{name}`, which makes the
 * Release content-addressed exactly like the R2 mirror
 * (`runtimeComponentMirrorUrl` in
 * `src/core/runtime-components/runtimeComponentManifest.ts`). Two
 * consequences follow, and both matter:
 *
 * - Upgrading a component appends one new attachment; the superseded one
 *   stays, because already-shipped Core versions baked its hash and will
 *   keep asking for it forever.
 * - Nothing is ever deleted or overwritten. Distinct bytes never collide on
 *   a name, so there is never a reason to.
 *
 * This module is the single source of truth for that naming and for which
 * artifacts exist at all, read straight from `registry.json` — the publish
 * and audit commands in `runtime-assets.mjs` both go through it, so they
 * can never drift from each other or from what `npm run runtime:build`
 * actually declared.
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/** The permanent Release every runtime component artifact is attached to. */
export const RUNTIME_ASSET_TAG = 'runtime-assets'

/**
 * A Release has one flat attachment namespace, and four components all ship
 * a file called `entry.js`. Leading with the hash disambiguates them and
 * makes the name self-verifying.
 */
export function runtimeAssetReleaseName(sha256, name) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Runtime component artifact sha256 is invalid: ${sha256}`)
  }
  return `${sha256}-${name}`
}

/**
 * Flattens a parsed registry into one entry per artifact. `entry` paths are
 * repository-relative (`runtime-components/<id>/dist/entry.js`), as are
 * asset `path`s, so both resolve against `root` the same way.
 */
export function listRegistryRuntimeAssets(registry) {
  const entries = []
  for (const descriptor of registry.components ?? []) {
    entries.push({
      componentId: descriptor.id,
      name: 'entry.js',
      sha256: descriptor.sha256,
      byteSize: descriptor.byteSize,
      repoPath: descriptor.entry,
      releaseName: runtimeAssetReleaseName(descriptor.sha256, 'entry.js'),
    })
    for (const asset of descriptor.assets ?? []) {
      entries.push({
        componentId: descriptor.id,
        name: asset.name,
        sha256: asset.sha256,
        byteSize: asset.byteSize,
        repoPath: asset.path,
        releaseName: runtimeAssetReleaseName(asset.sha256, asset.name),
      })
    }
  }
  return entries
}

export async function listRuntimeComponentReleaseAssets(root = process.cwd()) {
  const registry = JSON.parse(
    await readFile(path.join(root, 'runtime-components/registry.json'), 'utf8'),
  )
  return listRegistryRuntimeAssets(registry).map((entry) => ({
    ...entry,
    sourcePath: path.join(root, entry.repoPath),
  }))
}

/**
 * Stages every artifact declared by the local registry into `destDir` under
 * its flat Release name, ready for `gh release upload`. Reads from `dist/`,
 * i.e. requires `npm run build`/`npm run runtime:build` to have already run.
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
