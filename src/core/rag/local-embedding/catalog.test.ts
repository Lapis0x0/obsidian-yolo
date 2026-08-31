import {
  DTYPE_WEIGHT_FILES,
  OPTIONAL_MODEL_FILES,
  REQUIRED_MODEL_FILES,
} from '../../../../runtime-components/embedding-engine/src/protocol'

import {
  LOCAL_EMBEDDING_CATALOG,
  getLocalEmbeddingCatalogEntry,
} from './catalog'

const DECLARED_MODEL_FILE_NAMES = new Set([
  ...REQUIRED_MODEL_FILES,
  ...OPTIONAL_MODEL_FILES,
])

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

describe('LOCAL_EMBEDDING_CATALOG', () => {
  it('is non-empty', () => {
    expect(LOCAL_EMBEDDING_CATALOG.length).toBeGreaterThan(0)
  })

  it('has unique ids', () => {
    const ids = LOCAL_EMBEDDING_CATALOG.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(LOCAL_EMBEDDING_CATALOG.map((entry) => [entry.id, entry] as const))(
    '%s: files are non-empty and every path is declared by the engine protocol',
    (_id, entry) => {
      expect(entry.files.length).toBeGreaterThan(0)
      for (const file of entry.files) {
        expect(DECLARED_MODEL_FILE_NAMES.has(file.path)).toBe(true)
        expect(file.byteSize).toBeGreaterThan(0)
        expect(file.sha256).toMatch(SHA256_HEX_PATTERN)
      }
    },
  )

  it.each(LOCAL_EMBEDDING_CATALOG.map((entry) => [entry.id, entry] as const))(
    '%s: every required model file is declared',
    (_id, entry) => {
      const declaredPaths = new Set(entry.files.map((file) => file.path))
      for (const required of REQUIRED_MODEL_FILES) {
        expect(declaredPaths.has(required)).toBe(true)
      }
    },
  )

  it.each(LOCAL_EMBEDDING_CATALOG.map((entry) => [entry.id, entry] as const))(
    '%s: totalBytes equals the sum of file byteSizes',
    (_id, entry) => {
      const sum = entry.files.reduce((total, file) => total + file.byteSize, 0)
      expect(entry.totalBytes).toBe(sum)
    },
  )

  it.each(LOCAL_EMBEDDING_CATALOG.map((entry) => [entry.id, entry] as const))(
    '%s: dimension and maxTokens are positive',
    (_id, entry) => {
      expect(entry.dimension).toBeGreaterThan(0)
      expect(entry.maxTokens).toBeGreaterThan(0)
    },
  )

  it.each(LOCAL_EMBEDDING_CATALOG.map((entry) => [entry.id, entry] as const))(
    '%s: revision looks like a pinned commit SHA, not a branch name',
    (_id, entry) => {
      expect(entry.revision).toMatch(/^[0-9a-f]{40}$/)
    },
  )

  it.each(
    LOCAL_EMBEDDING_CATALOG.filter(
      (entry) => entry.pooling === 'last-token',
    ).map((entry) => [entry.id, entry] as const),
  )(
    '%s: last-token pooling entries declare tokenizer_config.json (padding_side source)',
    (_id, entry) => {
      const declaredPaths = new Set(entry.files.map((file) => file.path))
      expect(declaredPaths.has('tokenizer_config.json')).toBe(true)
    },
  )

  it.each(LOCAL_EMBEDDING_CATALOG.map((entry) => [entry.id, entry] as const))(
    "%s: declared files include every weight file its dtype's DTYPE_WEIGHT_FILES entry requires",
    (_id, entry) => {
      const declaredPaths = new Set(entry.files.map((file) => file.path))
      const requiredWeightFiles = DTYPE_WEIGHT_FILES[entry.dtype ?? 'q8']
      for (const weightFile of requiredWeightFiles) {
        expect(declaredPaths.has(weightFile)).toBe(true)
      }
    },
  )

  it('getLocalEmbeddingCatalogEntry finds an entry by id', () => {
    expect(getLocalEmbeddingCatalogEntry('bge-m3')?.hfRepo).toBe(
      'Xenova/bge-m3',
    )
  })

  it('getLocalEmbeddingCatalogEntry returns undefined for an unknown id', () => {
    expect(getLocalEmbeddingCatalogEntry('does-not-exist')).toBeUndefined()
  })
})
