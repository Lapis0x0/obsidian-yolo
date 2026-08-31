import { z } from 'zod'

import type { SerializedChatUserMessage } from '../../types/chat'
import type { ToolEditSummary } from '../../types/tool-call.types'

import { CLI_RUNTIME_IDS } from './types'
import type { CliRuntimeId, CliSessionRef } from './types'

export const CLI_SESSION_INDEX_SCHEMA_VERSION = 1 as const

const cliRuntimeIdSchema = z.enum(CLI_RUNTIME_IDS)

const serializedUserMessageSchema = z.custom<SerializedChatUserMessage>(
  (value) => {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Partial<SerializedChatUserMessage>
    return (
      candidate.role === 'user' &&
      typeof candidate.id === 'string' &&
      Array.isArray(candidate.mentionables)
    )
  },
)

const toolEditSummarySchema = z.custom<ToolEditSummary>((value) => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ToolEditSummary>
  return (
    Array.isArray(candidate.files) &&
    typeof candidate.totalFiles === 'number' &&
    typeof candidate.totalAddedLines === 'number' &&
    typeof candidate.totalRemovedLines === 'number'
  )
})

const cliTurnConfigurationSchema = z.object({
  modelId: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
})

const cliTurnOverlaySchema = z.object({
  clientUserMessageId: z.string().min(1).optional(),
  transportHash: z.string(),
  userMessage: serializedUserMessageSchema,
  configuration: cliTurnConfigurationSchema.optional(),
})

export const cliSessionIndexEntrySchema = z.object({
  runtimeId: cliRuntimeIdSchema,
  nativeSessionId: z.string().min(1),
  sessionPathHint: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  turnOverlays: z.array(cliTurnOverlaySchema).optional(),
  turnEditSummaryByUserMessageId: z
    .record(z.string(), toolEditSummarySchema)
    .optional(),
  modelId: z.string().nullable().optional(),
  reasoningEffort: z.string().nullable().optional(),
  lastCacheHitRate: z.number().min(0).max(1).optional(),
})

export type CliSessionIndexEntry = z.infer<typeof cliSessionIndexEntrySchema>

export const cliSessionIndexDocumentSchema = z
  .object({
    schemaVersion: z.literal(CLI_SESSION_INDEX_SCHEMA_VERSION),
    sessions: z.record(z.string(), cliSessionIndexEntrySchema),
  })
  .superRefine((document, context) => {
    for (const [key, entry] of Object.entries(document.sessions)) {
      if (key !== getCliSessionIndexKey(entry)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sessions', key],
          message:
            'Session index key does not match its runtime/native identity.',
        })
      }
    }
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
  ...(entry.sessionPathHint ? { sessionPathHint: entry.sessionPathHint } : {}),
  ...(entry.profileId ? { profileId: entry.profileId } : {}),
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

export type CliSessionIndexMutator = (
  current: CliSessionIndexEntry | null,
) => CliSessionIndexEntry

export type CliSessionIndexStore = {
  list(): Promise<CliSessionIndexEntry[]>
  get(ref: CliSessionRef): Promise<CliSessionIndexEntry | null>
  upsert(entry: CliSessionIndexEntry): Promise<void>
  update(
    ref: CliSessionRef,
    mutator: CliSessionIndexMutator,
  ): Promise<CliSessionIndexEntry>
  remove(ref: CliSessionRef): Promise<boolean>
}
