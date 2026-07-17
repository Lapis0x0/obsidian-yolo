import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import prettier from 'prettier'

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const OUTPUT_PATH = fileURLToPath(
  new URL('../src/utils/llm/openrouter-model-capabilities.ts', import.meta.url),
)

function assertModel(value, index) {
  if (!value || typeof value !== 'object') {
    throw new Error(`OpenRouter model at index ${index} is not an object`)
  }
  if (typeof value.id !== 'string' || value.id.trim() === '') {
    throw new Error(`OpenRouter model at index ${index} has no valid id`)
  }
  if (!Number.isInteger(value.context_length) || value.context_length <= 0) {
    throw new Error(`OpenRouter model ${value.id} has no valid context_length`)
  }

  const inputModalities = value.architecture?.input_modalities
  if (!Array.isArray(inputModalities) || !inputModalities.includes('text')) {
    throw new Error(`OpenRouter model ${value.id} has no text input modality`)
  }

  return {
    id: value.id,
    context: value.context_length,
    modalities: inputModalities.flatMap((modality) =>
      modality === 'text' ? ['text'] : modality === 'image' ? ['vision'] : [],
    ),
  }
}

function buildCapabilities(models) {
  const capabilities = new Map()

  models.forEach((value, index) => {
    const model = assertModel(value, index)
    const key = model.id.split('/').at(-1)
    const existing = capabilities.get(key)
    if (existing) {
      throw new Error(
        `OpenRouter model id collision after removing provider prefixes: ${existing.id} and ${model.id}`,
      )
    }
    capabilities.set(key, model)
  })

  return [...capabilities.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )
}

async function formatSnapshot(capabilities, generatedDate) {
  const entries = capabilities
    .map(
      ([key, capability]) =>
        `  ${JSON.stringify(key)}: ${JSON.stringify({
          context: capability.context,
          modalities: capability.modalities,
        })},`,
    )
    .join('\n')

  const source = `// Generated from ${OPENROUTER_MODELS_URL} on ${generatedDate}.
export type OpenRouterChatModelCapability = {
  context?: number
  modalities?: Array<'text' | 'vision'>
}

export const OPENROUTER_MODEL_CAPABILITIES: Record<
  string,
  OpenRouterChatModelCapability
> = {
${entries}
}
`

  return prettier.format(source, {
    ...(await prettier.resolveConfig(OUTPUT_PATH)),
    parser: 'typescript',
  })
}

const response = await fetch(OPENROUTER_MODELS_URL, {
  headers: {
    Accept: 'application/json',
    'User-Agent': 'obsidian-yolo-model-capability-updater',
  },
})
if (!response.ok) {
  throw new Error(
    `OpenRouter model request failed: ${response.status} ${response.statusText}`,
  )
}

const payload = await response.json()
if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
  throw new Error('OpenRouter model response has no data array')
}

const capabilities = buildCapabilities(payload.data)
const existingSnapshot = await readFile(OUTPUT_PATH, 'utf8')
const existingDate = existingSnapshot.match(
  /^\/\/ Generated from .* on (\d{4}-\d{2}-\d{2})\.$/m,
)?.[1]
if (!existingDate) {
  throw new Error('Existing OpenRouter snapshot has no valid generated date')
}

const snapshotWithExistingDate = await formatSnapshot(
  capabilities,
  existingDate,
)
if (snapshotWithExistingDate === existingSnapshot) {
  console.log(
    `OpenRouter snapshot is already current (${capabilities.length} models)`,
  )
  process.exit(0)
}

const generatedDate = new Date().toISOString().slice(0, 10)
const nextSnapshot = await formatSnapshot(capabilities, generatedDate)
await writeFile(OUTPUT_PATH, nextSnapshot)
console.log(`Updated OpenRouter snapshot (${capabilities.length} models)`)
