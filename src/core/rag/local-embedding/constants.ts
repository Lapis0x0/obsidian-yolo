/**
 * Deliberately import-free (no `obsidian`, no other `core/` modules) so both
 * `settings/schema/settings.ts` (which must recognize this id when
 * normalizing `embeddingModels` references — see `normalizeYoloSettingsReferences`)
 * and `core/rag/local-embedding/*` can depend on it without creating a cycle
 * between the settings layer and the RAG layer.
 *
 * `yolo-local` is a reserved `EmbeddingModel.providerId` value that never has
 * a matching entry in `settings.providers` — local embedding models are not
 * "a provider" in the LLMProvider sense (no API key/base URL to configure),
 * they're a RAG-only capability backed by the `embedding-engine` runtime
 * component. See docs/plans/08-22-local-embedding/00-plan.md §3.5.
 */
export const LOCAL_EMBEDDING_PROVIDER_ID = 'yolo-local'

/** Default Hugging Face Hub endpoint used to resolve model file download URLs. */
export const DEFAULT_LOCAL_EMBEDDING_ENDPOINT = 'https://huggingface.co'

/**
 * Preset mirror endpoint offered alongside the default in the endpoint
 * picker (P3 UI) for users who can't reach huggingface.co directly.
 */
export const HF_MIRROR_LOCAL_EMBEDDING_ENDPOINT = 'https://hf-mirror.com'
