import { z } from 'zod'

import type { CliRuntimeId, CliSessionRef } from './types'

export const CLI_SESSION_INDEX_SCHEMA_VERSION = 1 as const

const cliRuntimeIdSchema = z.enum(['claude-code', 'codex'])

export const cliSessionIndexEntrySchema = z.object({
  runtimeId: cliRuntimeIdSchema,
  nativeSessionId: z.string().min(1),
  sessionPathHint: z.string().min(1).optional(),
  assistantId: z.string().min(1).optional(),
  lastOpenedAt: z.number().nonnegative().optional(),
  isPinned: z.boolean().optional(),
  pinnedAt: z.number().nonnegative().optional(),
})

export type CliSessionIndexEntry = z.infer<typeof cliSessionIndexEntrySchema>

export const cliSessionIndexDocumentSchema = z.object({
  schemaVersion: z.literal(CLI_SESSION_INDEX_SCHEMA_VERSION),
  sessions: z.record(z.string(), cliSessionIndexEntrySchema),
})

export type CliSessionIndexDocument = z.infer<
  typeof cliSessionIndexDocumentSchema
>

export const EMPTY_CLI_SESSION_INDEX: CliSessionIndexDocument = {
  schemaVersion: CLI_SESSION_INDEX_SCHEMA_VERSION,
  sessions: {},
}

export const getCliSessionIndexKey = ({
  runtimeId,
  nativeSessionId,
}: Pick<CliSessionRef, 'runtimeId' | 'nativeSessionId'>): string =>
  `${runtimeId}:${encodeURIComponent(nativeSessionId)}`

export const toCliSessionRef = (
  entry: CliSessionIndexEntry,
): CliSessionRef => ({
  runtimeId: entry.runtimeId,
  nativeSessionId: entry.nativeSessionId,
  ...(entry.sessionPathHint
    ? { sessionPathHint: entry.sessionPathHint }
    : {}),
})

export const createCliSessionIndexEntry = ({
  runtimeId,
  nativeSessionId,
  ...overlay
}: {
  runtimeId: CliRuntimeId
  nativeSessionId: string
} & Omit<CliSessionIndexEntry, 'runtimeId' | 'nativeSessionId'>) =>
  cliSessionIndexEntrySchema.parse({
    runtimeId,
    nativeSessionId,
    ...overlay,
  })

export interface CliSessionIndexStore {
  list(): Promise<CliSessionIndexEntry[]>
  get(ref: CliSessionRef): Promise<CliSessionIndexEntry | null>
  upsert(entry: CliSessionIndexEntry): Promise<void>
  remove(ref: CliSessionRef): Promise<boolean>
}
