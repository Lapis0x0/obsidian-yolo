/**
 * Shared between `build-runtime-components.mjs` and `distribution.mjs` —
 * both plain Node ESM scripts (the single-source-of-truth reasoning is the
 * same as `runtimeComponentAssetName.mjs`: the host's TypeScript can't
 * import a `scripts/` module).
 *
 * Maps a runtime component's declared asset name to the local file it's
 * built from. `build-runtime-components.mjs` copies from here into
 * `dist/assets/<name>` (a gitignored build output — see `.gitignore`).
 * `distribution.mjs` reads the *same* local bytes directly at publish time,
 * since — unlike `entry.js` — assets are never committed, so there is
 * nothing to fetch from a tagged Git ref; CI runs `npm ci` before either
 * script runs, so `node_modules` is always present.
 */
const RUNTIME_COMPONENT_ASSET_SOURCES = {
  'embedding-engine': (name) => `node_modules/onnxruntime-web/dist/${name}`,
}

export function resolveRuntimeComponentAssetSource(componentId, name) {
  const resolve = RUNTIME_COMPONENT_ASSET_SOURCES[componentId]
  if (!resolve) {
    throw new Error(
      `Runtime component "${componentId}" declares assets but has no known asset source mapping`,
    )
  }
  return resolve(name)
}
