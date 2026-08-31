/**
 * Makes this worker look like the plain browser Worker it actually is,
 * before any Transformers.js / onnxruntime-web code observes the global
 * scope.
 *
 * Obsidian's desktop windows run with `nodeIntegrationInWorker`, so a
 * Worker spawned from a Blob URL still gets Node's `process` global with
 * `process.release.name === 'node'`. Transformers.js's environment probe
 * (`src/env.js`) reads exactly that to decide which ONNX Runtime binding to
 * use, and would pick `onnxruntime-node` — which this browser-platform
 * bundle resolves to an empty stub — leaving `env.backends.onnx` undefined
 * (`TypeError: Cannot read properties of undefined (reading 'wasm')` while
 * installing `wasmPaths`) and `wasm` missing from its supported devices.
 * onnxruntime-web's Emscripten `.mjs` loader, dynamically imported later
 * during session creation, runs its own `ENVIRONMENT_IS_NODE` check and
 * needs the same view — so `process` stays hidden for the worker's whole
 * lifetime. Nothing in this worker uses Node APIs: model bytes and wasm
 * assets are injected by the host over `postMessage`.
 */
delete (globalThis as { process?: unknown }).process
