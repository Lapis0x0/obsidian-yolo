/**
 * Maps a `env.customCache.match()` request URL back to one of the fixed
 * model file names declared in `protocol.ts` (`REQUIRED_MODEL_FILES` /
 * `OPTIONAL_MODEL_FILES`), so `worker.ts` can serve injected bytes without
 * ever touching the network or filesystem.
 *
 * Transformers.js's `getModelFile()` (`utils/hub.js`) tries two candidate
 * strings per file, in order:
 *  - a "local path": `${env.localModelPath}/${modelId}/${name}`
 *    (e.g. `/models/yolo-local-embedding-model/config.json`)
 *  - a "remote URL": `${env.remoteHost}/${modelId}/resolve/${revision}/${name}`
 *    (e.g. `https://huggingface.co/yolo-local-embedding-model/resolve/main/config.json`)
 *
 * Both end with `/${name}`, but the prefix differs and isn't worth
 * reproducing exactly (it's private, version-dependent Transformers.js
 * internals) — a plain `url.endsWith(name)` is not safe either, though:
 * `"tokenizer_config.json".endsWith("config.json") === true`, so naive
 * suffix matching silently hands back the wrong file whenever one declared
 * name is a *character-level* (not path-segment-level) suffix of another.
 *
 * The fix is to require the match be bounded by a path separator (or be the
 * whole string) rather than any character boundary, after stripping a
 * trailing query string / fragment and URL-decoding — robust to both
 * candidate shapes without depending on Transformers.js's exact URL
 * construction.
 */
export function matchDeclaredModelFile(
  url: string,
  declaredNames: Iterable<string>,
): string | undefined {
  const withoutFragment = url.split('#', 1)[0] ?? url
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? withoutFragment
  let candidate: string
  try {
    candidate = decodeURIComponent(withoutQuery)
  } catch {
    candidate = withoutQuery
  }
  for (const name of declaredNames) {
    if (candidate === name || candidate.endsWith(`/${name}`)) return name
  }
  return undefined
}
