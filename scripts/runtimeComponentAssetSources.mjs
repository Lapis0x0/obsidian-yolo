/**
 * Maps a runtime component's declared asset name to the local file it's
 * built from. `build-runtime-components.mjs` copies from here into
 * `dist/assets/<name>` (a gitignored build output — see `.gitignore`) and
 * records its byteSize/sha256 in `registry.json`, which is what every later
 * stage verifies against; `npm ci` runs before the build, so `node_modules`
 * is always present.
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
