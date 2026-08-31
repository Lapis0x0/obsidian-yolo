#!/usr/bin/env node
/**
 * Runs the real `embedding-engine` worker bundle end-to-end against a real
 * ONNX text-embedding model (not a mock), outside Obsidian — the closest
 * thing to a browser/Electron Worker this repo can exercise from a plain
 * `node` invocation.
 *
 * Usage:
 *   node scripts/smoke-embedding-engine.mjs --model-dir <dir> [options]
 *
 * Pass --text more than once to embed a real batch (e.g. --text short
 * --text "a much longer sentence...") — this is the only way to exercise
 * padding at all; a batch of one never pads, so it can't catch a
 * `last-token` pooling / `padding_side` mismatch.
 *
 * <dir> must contain the files `runtime-components/embedding-engine/src/protocol.ts`
 * declares in `REQUIRED_MODEL_FILES` / `OPTIONAL_MODEL_FILES`:
 *   config.json, tokenizer.json                              (required)
 *   tokenizer_config.json, special_tokens_map.json           (optional)
 *   the ONNX weight file(s) matching --dtype (see below)     (required)
 *
 * --dtype selects which ONNX weight `worker.ts` asks Transformers.js to
 * load (default 'q8'); --weights-file names the weight file relative to
 * <dir> (default 'onnx/model_quantized.onnx'), and --weights-data-file
 * names a second file for dtypes whose weights are split into a small
 * header + a separate large data file (e.g. fp16's
 * `onnx/model_fp16.onnx` + `onnx/model_fp16.onnx_data`).
 *
 * To fetch a small real model for this (~23 MB, q8 all-MiniLM-L6-v2):
 *   mkdir -p /tmp/embedding-smoke-model/onnx
 *   BASE=https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main
 *   curl -fL "$BASE/config.json" -o /tmp/embedding-smoke-model/config.json
 *   curl -fL "$BASE/tokenizer.json" -o /tmp/embedding-smoke-model/tokenizer.json
 *   curl -fL "$BASE/tokenizer_config.json" -o /tmp/embedding-smoke-model/tokenizer_config.json
 *   curl -fL "$BASE/special_tokens_map.json" -o /tmp/embedding-smoke-model/special_tokens_map.json
 *   curl -fL "$BASE/onnx/model_quantized.onnx" -o /tmp/embedding-smoke-model/onnx/model_quantized.onnx
 *   npm run runtime:build
 *   node scripts/smoke-embedding-engine.mjs --model-dir /tmp/embedding-smoke-model
 *
 * One thing stands in for what only a real browser/Electron Worker
 * provides, confined to this test harness (never touching the shipped
 * `worker.ts`/`entry.ts` source): Node's dynamic `import()` rejects `blob:`
 * URLs outright ("Only URLs with a scheme in: file, data, and node are
 * supported"), which real Chromium/Electron Workers support, so
 * `URL.createObjectURL` is swapped here for a `data:` URL encoder and
 * onnxruntime-web's `import()` of its `.mjs` loader still resolves.
 *
 * Node's `process` global is NOT hidden here: Obsidian's desktop Workers
 * expose one too (`nodeIntegrationInWorker`), and `browserEnv.ts` in the
 * worker bundle deletes it on load precisely because Transformers.js would
 * otherwise pick its `onnxruntime-node` binding. Running this harness with
 * `process` in place is what keeps that shim covered.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const { values: args } = parseArgs({
  options: {
    'model-dir': { type: 'string' },
    dimension: { type: 'string', default: '384' },
    pooling: { type: 'string', default: 'mean' },
    normalize: { type: 'string', default: 'true' },
    'max-tokens': { type: 'string', default: '256' },
    text: { type: 'string', multiple: true, default: ['hello'] },
    dtype: { type: 'string', default: 'q8' },
    'weights-file': {
      type: 'string',
      default: 'onnx/model_quantized.onnx',
    },
    'weights-data-file': { type: 'string', default: '' },
  },
})

if (!args['model-dir']) {
  console.error(
    'Usage: node scripts/smoke-embedding-engine.mjs --model-dir <dir> [--dimension 384] [--pooling mean] [--normalize true] [--max-tokens 256] [--text hello] [--text "..." ...] [--dtype q8] [--weights-file onnx/model_quantized.onnx] [--weights-data-file <path>]',
  )
  process.exitCode = 1
  process.exit()
}
const modelDir = path.resolve(args['model-dir'])
const spec = {
  dimension: Number(args.dimension),
  pooling: args.pooling,
  normalize: args.normalize !== 'false',
  maxTokens: Number(args['max-tokens']),
  dtype: args.dtype,
}
const weightsFile = args['weights-file']
const weightsDataFile = args['weights-data-file'] || null
// This release's worker only supports the 'wasm' device — see
// `EmbeddingWorkerInitRequest` in protocol.ts. WebGPU/JSEP returns in a
// future release.
const device = 'wasm'

console.log(`Model directory: ${modelDir}`)
console.log(`Spec: ${JSON.stringify(spec)}, device: ${device}`)

console.log('Bundling worker.ts...')
const result = await esbuild.build({
  entryPoints: [
    path.join(root, 'runtime-components/embedding-engine/src/worker.ts'),
  ],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  minify: false,
  write: false,
  conditions: ['onnxruntime-web-use-extern-wasm'],
  define: { 'process.env.NODE_ENV': JSON.stringify('development') },
  logLevel: 'silent',
})
const workerSource = result.outputFiles[0].text
console.log(`Worker bundle: ${(workerSource.length / 1024).toFixed(1)} KB`)

class TestBlob {
  constructor(parts, options) {
    this.parts = parts.map((part) =>
      part instanceof Uint8Array ? part : new Uint8Array(part),
    )
    this.type = options?.type ?? ''
  }
}
globalThis.URL.createObjectURL = (blob) => {
  const total = blob.parts.reduce((sum, part) => sum + part.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of blob.parts) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return `data:${blob.type};base64,${Buffer.from(merged).toString('base64')}`
}
globalThis.URL.revokeObjectURL = () => {}
globalThis.Blob = TestBlob

const responses = []
globalThis.self = globalThis
globalThis.self.postMessage = (message) => {
  responses.push(message)
}
globalThis.self.onmessage = null

// The worker bundle deletes `globalThis.process` itself (`browserEnv.ts`);
// keep a reference so this harness can still use it afterwards.
const realProcess = globalThis.process
;(0, eval)(workerSource)
if (globalThis.process !== undefined) {
  console.error(
    'SMOKE TEST FAILED: worker bundle did not hide `process`; Transformers.js will select onnxruntime-node',
  )
  realProcess.exit(1)
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      const match = responses.find(predicate)
      if (match) return resolve(match)
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('Timed out waiting for worker response'))
      }
      setTimeout(tick, 20)
    }
    tick()
  })
}

function formatWorkerError(error) {
  if (!error || typeof error !== 'object') return String(error)
  const device = error.device ? `, device: ${error.device}` : ''
  return `${error.message} (stage: ${error.stage}${device})`
}

async function readAssetsInto(target, names, sourceDir) {
  for (const name of names) {
    const bytes = await readFile(path.join(sourceDir, name))
    target[name] = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    )
  }
}

async function main() {
  const wasm = {}
  await readAssetsInto(
    wasm,
    ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'],
    path.join(root, 'runtime-components/embedding-engine/dist/assets'),
  )

  const modelFiles = {}
  await readAssetsInto(
    modelFiles,
    [
      'config.json',
      'tokenizer.json',
      weightsFile,
      ...(weightsDataFile ? [weightsDataFile] : []),
    ],
    modelDir,
  )
  for (const optional of ['tokenizer_config.json', 'special_tokens_map.json']) {
    try {
      await readAssetsInto(modelFiles, [optional], modelDir)
    } catch {
      console.log(`(optional file not present, skipping: ${optional})`)
    }
  }

  console.log('Sending init...')
  globalThis.self.onmessage({
    data: {
      type: 'init',
      requestId: 1,
      wasm,
      modelFiles,
      spec,
      device,
      numThreads: 1,
    },
  })
  const initResult = await waitFor(
    (message) => message.type === 'init-result' && message.requestId === 1,
    120_000,
  )
  if (!initResult.ok) {
    throw new Error(`init failed: ${formatWorkerError(initResult.error)}`)
  }
  console.log(`init ok, device: ${initResult.device}`)

  console.log(`Sending embed(${JSON.stringify(args.text)})...`)
  globalThis.self.onmessage({
    data: { type: 'embed', requestId: 2, texts: args.text },
  })
  const embedResult = await waitFor(
    (message) => message.type === 'embed-result' && message.requestId === 2,
    60_000,
  )
  if (!embedResult.ok) {
    throw new Error(`embed failed: ${formatWorkerError(embedResult.error)}`)
  }
  const vectors = embedResult.vectors.map((raw) => new Float32Array(raw))
  const norms = vectors.map((vector) =>
    Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)),
  )
  vectors.forEach((vector, index) => {
    console.log(`[${index}] "${args.text[index]}"`)
    console.log('  dimension:', vector.length)
    console.log('  norm:', norms[index])
    console.log('  first 5 values:', Array.from(vector.slice(0, 5)))
  })

  console.log('Sending dispose...')
  globalThis.self.onmessage({ data: { type: 'dispose', requestId: 3 } })
  const disposeResult = await waitFor(
    (message) => message.type === 'dispose-result' && message.requestId === 3,
    30_000,
  )
  if (!disposeResult.ok) {
    throw new Error(`dispose failed: ${formatWorkerError(disposeResult.error)}`)
  }
  console.log('dispose ok')

  vectors.forEach((vector, index) => {
    if (vector.length !== spec.dimension) {
      throw new Error(
        `[${index}] expected dimension ${spec.dimension}, got ${vector.length}`,
      )
    }
    if (spec.normalize && Math.abs(norms[index] - 1) > 0.01) {
      throw new Error(
        `[${index}] expected unit-normalized vector, got norm ${norms[index]}`,
      )
    }
  })
  console.log('SMOKE TEST PASSED')
}

main()
  .catch((error) => {
    console.error('SMOKE TEST FAILED:', error)
    realProcess.exitCode = 1
  })
  .finally(() => {
    globalThis.process = realProcess
  })
