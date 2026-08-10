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
  'node_modules/@electric-sql/pglite/',
  'node_modules/drizzle-orm/',
  'inline-pdfjs-worker',
  'inline-pglite-worker',
]
for (const dependency of forbidden) {
  const match = inputs.find((input) => input.includes(dependency))
  if (match) {
    throw new Error(`Host bundle contains runtime dependency: ${match}`)
  }
}

const expectedClosures = {
  tokenizer: ['node_modules/gpt-tokenizer/'],
  'pdf-engine': ['node_modules/pdfjs-dist/', 'node_modules/pdf-lib/'],
  'pglite-engine': [
    'node_modules/@electric-sql/pglite/',
    'node_modules/drizzle-orm/pglite/',
  ],
}
for (const [componentId, dependencies] of Object.entries(expectedClosures)) {
  const metafile = JSON.parse(
    await readFile(`runtime-components/${componentId}/dist/meta.json`, 'utf8'),
  )
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
