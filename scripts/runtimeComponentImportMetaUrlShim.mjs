/**
 * `import.meta.url` for runtime components that declare `"node": true` (see
 * `nodeComponentBuildOptions` in `build-runtime-components.mjs`). Such a
 * component runs as a Blob `<script>` in Obsidian's desktop renderer, where
 * `import.meta.url` does not exist; bundled SDKs only pass it to
 * `createRequire`, which needs a file URL and then resolves Node builtins
 * regardless of the base path. The renderer's own `__filename` provides one,
 * as the host's `import-meta-url-shim.js` does for `main.js`.
 */
import { pathToFileURL } from 'node:url'

export const import_meta_url = pathToFileURL(__filename).href
