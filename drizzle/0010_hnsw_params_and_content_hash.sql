DROP INDEX IF EXISTS "embeddings_embedding_128_index";--> statement-breakpoint
DROP INDEX IF EXISTS "embeddings_embedding_256_index";--> statement-breakpoint
DROP INDEX IF EXISTS "embeddings_embedding_384_index";--> statement-breakpoint
DROP INDEX IF EXISTS "embeddings_embedding_512_index";--> statement-breakpoint
DROP INDEX IF EXISTS "embeddings_embedding_768_index";--> statement-breakpoint
DROP INDEX IF EXISTS "embeddings_embedding_1024_index";--> statement-breakpoint
DROP INDEX IF EXISTS "embeddings_embedding_1280_index";--> statement-breakpoint
DROP INDEX IF EXISTS "embeddings_embedding_1536_index";--> statement-breakpoint
DROP INDEX IF EXISTS "embeddings_embedding_1792_index";--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "content_hash" text;--> statement-breakpoint
CREATE INDEX "embeddings_embedding_128_index" ON "embeddings" USING hnsw ((embedding::vector(128)) vector_cosine_ops) WITH (m = 24, ef_construction = 100) WHERE dimension = 128;--> statement-breakpoint
CREATE INDEX "embeddings_embedding_256_index" ON "embeddings" USING hnsw ((embedding::vector(256)) vector_cosine_ops) WITH (m = 24, ef_construction = 100) WHERE dimension = 256;--> statement-breakpoint
CREATE INDEX "embeddings_embedding_384_index" ON "embeddings" USING hnsw ((embedding::vector(384)) vector_cosine_ops) WITH (m = 24, ef_construction = 100) WHERE dimension = 384;--> statement-breakpoint
CREATE INDEX "embeddings_embedding_512_index" ON "embeddings" USING hnsw ((embedding::vector(512)) vector_cosine_ops) WITH (m = 24, ef_construction = 100) WHERE dimension = 512;--> statement-breakpoint
CREATE INDEX "embeddings_embedding_768_index" ON "embeddings" USING hnsw ((embedding::vector(768)) vector_cosine_ops) WITH (m = 24, ef_construction = 100) WHERE dimension = 768;--> statement-breakpoint
CREATE INDEX "embeddings_embedding_1024_index" ON "embeddings" USING hnsw ((embedding::vector(1024)) vector_cosine_ops) WITH (m = 24, ef_construction = 100) WHERE dimension = 1024;--> statement-breakpoint
CREATE INDEX "embeddings_embedding_1280_index" ON "embeddings" USING hnsw ((embedding::vector(1280)) vector_cosine_ops) WITH (m = 24, ef_construction = 100) WHERE dimension = 1280;--> statement-breakpoint
CREATE INDEX "embeddings_embedding_1536_index" ON "embeddings" USING hnsw ((embedding::vector(1536)) vector_cosine_ops) WITH (m = 24, ef_construction = 100) WHERE dimension = 1536;--> statement-breakpoint
CREATE INDEX "embeddings_embedding_1792_index" ON "embeddings" USING hnsw ((embedding::vector(1792)) vector_cosine_ops) WITH (m = 24, ef_construction = 100) WHERE dimension = 1792;
