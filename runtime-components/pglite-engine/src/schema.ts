import { sql } from 'drizzle-orm'
import {
  bigint,
  customType,
  index,
  jsonb,
  pgTable,
  serial,
  smallint,
  text,
} from 'drizzle-orm/pg-core'

export type VectorMetaData = {
  startLine: number
  endLine: number
  page?: number
}

const vector = customType<{ data: number[] }>({
  dataType: () => 'vector',
  toDriver: (value) => JSON.stringify(value),
  fromDriver(value) {
    const parsed = JSON.parse(String(value)) as unknown
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== 'number')
    ) {
      throw new Error('Invalid vector value from database')
    }
    return parsed
  },
})

const dimensions = [128, 256, 384, 512, 768, 1024, 1280, 1536, 1792]

export const embeddingTable = pgTable(
  'embeddings',
  {
    id: serial('id').primaryKey(),
    path: text('path').notNull(),
    mtime: bigint('mtime', { mode: 'number' }).notNull(),
    content: text('content').notNull(),
    content_hash: text('content_hash'),
    model: text('model').notNull(),
    dimension: smallint('dimension').notNull(),
    embedding: vector('embedding'),
    metadata: jsonb('metadata').notNull().$type<VectorMetaData>(),
  },
  (table) => [
    index('embeddings_path_index').on(table.path),
    index('embeddings_model_index').on(table.model),
    index('embeddings_dimension_index').on(table.dimension),
    ...dimensions.map((dimension) =>
      index(`embeddings_embedding_${dimension}_index`)
        .using(
          'hnsw',
          sql.raw(
            `(${table.embedding.name}::vector(${dimension})) vector_cosine_ops`,
          ),
        )
        .where(sql.raw(`${table.dimension.name} = ${dimension}`)),
    ),
  ],
)

export type SelectEmbedding = typeof embeddingTable.$inferSelect
export type InsertEmbedding = typeof embeddingTable.$inferInsert
