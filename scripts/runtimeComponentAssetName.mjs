/**
 * Shared between `build-runtime-components.mjs` and `distribution.mjs` —
 * both plain Node ESM scripts, so this is a genuine single source of truth
 * for them (unlike the host's own `runtimeComponentManifest.ts`, which is
 * TypeScript compiled into the host bundle and can't import a `scripts/`
 * module without pulling build tooling into the host; it keeps its own
 * `ASSET_NAME_PATTERN` with the *same* literal pattern, cross-checked by a
 * consistency test in `runtimeComponentAssetName.test.mjs`).
 *
 * A declared asset name is used, unvalidated, as both a `dist/assets/<name>`
 * destination path (`build-runtime-components.mjs`) and a mirror path
 * segment (`distribution.mjs`) — a name like `../entry.js` or an absolute
 * path would let a malicious/malformed `component.config.json` or registry
 * write or fetch outside the intended directory. Requiring a plain
 * basename (letters/digits/`.`/`_`/`-`, no separators) closes that off.
 */
export const RUNTIME_COMPONENT_ASSET_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isValidRuntimeComponentAssetName(name) {
  // The pattern already requires an alphanumeric first character, which
  // rules out a bare "." or ".." (and any leading "/" or "\") on its own.
  return (
    typeof name === 'string' && RUNTIME_COMPONENT_ASSET_NAME_PATTERN.test(name)
  )
}
