/**
 * Static, hand-curated catalog of local embedding models — the only models
 * `yolo-local` (see `constants.ts`) will ever expose. Self-registration of
 * arbitrary HF repos is deliberately out of scope (see
 * docs/plans/08-22-local-embedding/00-plan.md §0 "模型范围"): most HF repos
 * don't ship an ONNX export at all, and a wrong `pooling`/`normalize`/prefix
 * guess would silently poison every vector in a knowledge base.
 *
 * Every `files` entry's `path` must be one of `REQUIRED_MODEL_FILES` /
 * `OPTIONAL_MODEL_FILES` from
 * `runtime-components/embedding-engine/src/protocol.ts` — that's what the
 * engine's `loadModelFile` callback (wired to `LocalEmbeddingModelManager`)
 * actually requests. `catalog.test.ts` asserts this.
 *
 * `revision` is a pinned commit SHA (not a branch name like `main`) so that
 * `sha256`/`byteSize` stay valid forever — HF branch heads move. Every
 * `sha256`/`byteSize` below was captured directly from the Hub API
 * (`GET /api/models/<repo>/tree/<revision>?recursive=true`, which reports
 * `lfs.oid` — itself a SHA-256 — for LFS-tracked files) or, for small
 * non-LFS text files, by downloading the file and hashing it locally. See
 * the P2 implementation report for the exact commands.
 */

export type LocalEmbeddingCatalogFile = Readonly<{
  /** Relative to the model's revision directory, e.g. `onnx/model_quantized.onnx`. */
  path: string
  byteSize: number
  /** Lowercase hex, 64 chars. */
  sha256: string
}>

export type LocalEmbeddingCatalogEntry = Readonly<{
  /** Our stable slug — becomes `EmbeddingModel.model` for entries created via the P3 UI. */
  id: string
  /** `<owner>/<name>` on Hugging Face Hub. */
  hfRepo: string
  /** Pinned commit SHA, not a branch name. */
  revision: string
  displayName: string
  languages: readonly string[]
  license: string
  dimension: number
  maxTokens: number
  pooling: 'mean' | 'cls'
  normalize: boolean
  files: readonly LocalEmbeddingCatalogFile[]
  /** `Σ files[].byteSize` — asserted by `catalog.test.ts`, used for download progress totals. */
  totalBytes: number
  /**
   * Task-instruction prefixes some models require to be prepended to the raw
   * text before embedding (e.g. E5's `"query: "` / `"passage: "`). Absent
   * for models that don't use one (e.g. BGE-M3's retrieval usage embeds
   * queries and documents identically — see the model's own Transformers.js
   * usage example).
   */
  prefixes?: Readonly<{ query: string; document: string }>
  /** Shown as a default suggestion in the P3 model picker. */
  recommended?: boolean
}>

export const LOCAL_EMBEDDING_CATALOG: readonly LocalEmbeddingCatalogEntry[] = [
  {
    id: 'multilingual-e5-small',
    hfRepo: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    displayName: 'Multilingual E5 Small',
    languages: ['multilingual'],
    license: 'MIT',
    dimension: 384,
    maxTokens: 512,
    pooling: 'mean',
    normalize: true,
    files: [
      {
        path: 'config.json',
        byteSize: 658,
        sha256:
          'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
      },
      {
        path: 'tokenizer.json',
        byteSize: 17082730,
        sha256:
          '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
      },
      {
        path: 'tokenizer_config.json',
        byteSize: 443,
        sha256:
          'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
      },
      {
        path: 'special_tokens_map.json',
        byteSize: 167,
        sha256:
          'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7',
      },
      {
        path: 'onnx/model_quantized.onnx',
        byteSize: 118308185,
        sha256:
          'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
      },
    ],
    totalBytes: 135392183,
    // intfloat's E5 model card: "Each input text should start with 'query: '
    // or 'passage: ', even for non-English texts."
    prefixes: {
      query: 'query: ',
      document: 'passage: ',
    },
    recommended: true,
  },
  {
    id: 'bge-small-en-v1.5',
    hfRepo: 'Xenova/bge-small-en-v1.5',
    revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
    displayName: 'BGE Small (English)',
    languages: ['en'],
    license: 'MIT',
    dimension: 384,
    maxTokens: 512,
    pooling: 'mean',
    normalize: true,
    files: [
      {
        path: 'config.json',
        byteSize: 683,
        sha256:
          'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350',
      },
      {
        path: 'tokenizer.json',
        byteSize: 711396,
        sha256:
          'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
      },
      {
        path: 'tokenizer_config.json',
        byteSize: 366,
        sha256:
          '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
      },
      {
        path: 'special_tokens_map.json',
        byteSize: 125,
        sha256:
          'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
      },
      {
        path: 'onnx/model_quantized.onnx',
        byteSize: 34014426,
        sha256:
          '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
      },
    ],
    totalBytes: 34726996,
    // BAAI's official prefix table and the Xenova Transformers.js usage
    // example both use this instruction for retrieval queries; passages are
    // embedded with no prefix.
    prefixes: {
      query: 'Represent this sentence for searching relevant passages: ',
      document: '',
    },
  },
  {
    id: 'bge-small-zh-v1.5',
    hfRepo: 'Xenova/bge-small-zh-v1.5',
    revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
    displayName: 'BGE Small (Chinese)',
    languages: ['zh'],
    license: 'MIT',
    dimension: 512,
    maxTokens: 512,
    pooling: 'mean',
    normalize: true,
    files: [
      {
        path: 'config.json',
        byteSize: 716,
        sha256:
          'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',
      },
      {
        path: 'tokenizer.json',
        byteSize: 439125,
        sha256:
          '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
      },
      {
        path: 'tokenizer_config.json',
        byteSize: 367,
        sha256:
          'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
      },
      {
        path: 'special_tokens_map.json',
        byteSize: 125,
        sha256:
          'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
      },
      {
        path: 'onnx/model_quantized.onnx',
        byteSize: 24010842,
        sha256:
          '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
      },
    ],
    totalBytes: 24451175,
    // BAAI's official prefix table (same table as the English v1.5 models).
    prefixes: {
      query: '为这个句子生成表示以用于检索相关文章：',
      document: '',
    },
  },
  {
    id: 'bge-m3',
    hfRepo: 'Xenova/bge-m3',
    revision: '4de13258303883538bd53b696b452bf8099f0858',
    displayName: 'BGE-M3',
    languages: ['multilingual'],
    license: 'MIT',
    dimension: 1024,
    maxTokens: 8192,
    pooling: 'cls',
    normalize: true,
    files: [
      {
        path: 'config.json',
        byteSize: 770,
        sha256:
          '734a79bf12d388c1467a4e3ab625f45de7f6906cffcfb93a1eca1787504bed95',
      },
      {
        path: 'tokenizer.json',
        byteSize: 17082821,
        sha256:
          '6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790',
      },
      {
        path: 'tokenizer_config.json',
        byteSize: 1173,
        sha256:
          '7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4',
      },
      {
        path: 'special_tokens_map.json',
        byteSize: 964,
        sha256:
          '8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835',
      },
      {
        path: 'onnx/model_quantized.onnx',
        byteSize: 569694530,
        sha256:
          '0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d',
      },
    ],
    totalBytes: 586780258,
    // BGE-M3's dense-retrieval usage example embeds queries and documents
    // identically — no instruction prefix, unlike the bge-*-v1.5 family.
  },
  {
    id: 'nomic-embed-text-v1.5',
    hfRepo: 'nomic-ai/nomic-embed-text-v1.5',
    revision: 'e9b6763023c676ca8431644204f50c2b100d9aab',
    displayName: 'Nomic Embed Text v1.5',
    languages: ['en'],
    license: 'Apache-2.0',
    dimension: 768,
    maxTokens: 8192,
    pooling: 'mean',
    normalize: true,
    files: [
      {
        path: 'config.json',
        byteSize: 2538,
        sha256:
          '9ab00bd92cee80a569f708140b7b6c1661a65891ff3765b1519e181ba2f2c92b',
      },
      {
        path: 'tokenizer.json',
        byteSize: 711396,
        sha256:
          'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
      },
      {
        path: 'tokenizer_config.json',
        byteSize: 1191,
        sha256:
          'd7e0000bcc80134debd2222220427e6bf5fa20a669f40a0d0d1409cc18e0a9bc',
      },
      {
        path: 'special_tokens_map.json',
        byteSize: 695,
        sha256:
          '5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a',
      },
      {
        path: 'onnx/model_quantized.onnx',
        byteSize: 137296292,
        sha256:
          'b4342336debaea79de872370664b0aaeb67dea4605513d00ee236ea871a81f27',
      },
    ],
    totalBytes: 138012112,
    // Nomic's model card: text *must* carry a task-instruction prefix; RAG
    // maps to its `search_document` / `search_query` tasks.
    prefixes: {
      query: 'search_query: ',
      document: 'search_document: ',
    },
  },
]

export function getLocalEmbeddingCatalogEntry(
  catalogId: string,
): LocalEmbeddingCatalogEntry | undefined {
  return LOCAL_EMBEDDING_CATALOG.find((entry) => entry.id === catalogId)
}
