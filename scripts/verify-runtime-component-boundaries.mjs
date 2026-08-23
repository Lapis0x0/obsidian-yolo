import { readFile } from 'node:fs/promises'

const hostMetafile = JSON.parse(await readFile('meta.json', 'utf8'))
const inputs = Object.keys(hostMetafile.inputs).map((path) =>
  path.replaceAll('\\', '/'),
)
const forbidden = [
  'node_modules/gpt-tokenizer/',
  'node_modules/pdfjs-dist/',
  'node_modules/pdf-lib/',
  'node_modules/@pdf-lib/',
  'node_modules/@huggingface/transformers/',
  'node_modules/onnxruntime-web/',
  'node_modules/onnxruntime-common/',
  'inline-pdfjs-worker',
]
for (const dependency of forbidden) {
  const match = inputs.find((input) => input.includes(dependency))
  if (match) {
    throw new Error(`Host bundle contains runtime dependency: ${match}`)
  }
}

const expectedClosures = {
  tokenizer: {
    metafile: 'runtime-components/tokenizer/dist/meta.json',
    dependencies: ['node_modules/gpt-tokenizer/'],
  },
  'pdf-engine': {
    metafile: 'runtime-components/pdf-engine/dist/meta.json',
    dependencies: ['node_modules/pdfjs-dist/', 'node_modules/pdf-lib/'],
  },
  // embedding-engine's own entry.js never imports Transformers.js/ORT — they
  // are only used inside the inlined inference worker (see
  // `runtime-components/embedding-engine/src/worker.ts` and the
  // `runtime-embedding-worker` esbuild plugin in
  // `scripts/build-runtime-components.mjs`), whose dependency graph is
  // captured separately in `dist/worker-meta.json` since it never appears in
  // the outer `entry.js` bundle's own metafile.
  'embedding-engine': {
    metafile: 'runtime-components/embedding-engine/dist/worker-meta.json',
    dependencies: [
      'node_modules/@huggingface/transformers/',
      'node_modules/onnxruntime-web/',
    ],
  },
}
for (const [
  componentId,
  { metafile: metafilePath, dependencies },
] of Object.entries(expectedClosures)) {
  const metafile = JSON.parse(await readFile(metafilePath, 'utf8'))
  const componentInputs = Object.keys(metafile.inputs).map((path) =>
    path.replaceAll('\\', '/'),
  )
  for (const dependency of dependencies) {
    if (!componentInputs.some((input) => input.includes(dependency))) {
      throw new Error(
        `Runtime component ${componentId} is missing dependency closure ${dependency}`,
      )
    }
  }
}

console.log('Runtime component boundaries verified')
