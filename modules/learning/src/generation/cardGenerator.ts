import { dump as dumpYaml } from 'js-yaml'
import { v4 as uuidv4 } from 'uuid'

import {
  type LearningVaultReadApi,
  normalizeLearningVaultPath,
} from '../domain/learningVaultReadApi'
import type { LearningVaultFileSnapshot } from '../domain/learningVaultWriteApi'

import type { LearningGenerationHost } from './host'

/**
 * Card-file utilities shared by the serial chapter engine (`emit_card` tool
 * results are written once via {@link buildCardsContent}) and generation
 * resume (which needs to tell an untouched cards.md shell apart from one
 * with real content, and to keep assigning fresh card UUIDs across chapters).
 *
 * The stream-parsing, fs_edit correction pass, and snapshot-rollback
 * machinery that used to live here was retired with the parallel,
 * markdown-as-protocol card generator (`generateCardsForChapter` /
 * `generateCardsParallel`) — cards are now produced by tool calls the host
 * validates inline, so there is nothing left to parse or roll back.
 */

export async function assertKnowledgeUnchanged(
  host: LearningGenerationHost,
  expected: LearningVaultFileSnapshot,
): Promise<void> {
  const current = await host.vaultWriter.readTextSnapshot(expected.path)
  if (!current) throw new Error(`Knowledge file disappeared: ${expected.path}`)
  if (current.content !== expected.content) {
    throw new Error(
      `Knowledge file changed during generation: ${expected.path}`,
    )
  }
}

export function buildCardsContent(
  chapterTitle: string,
  blocks: string[],
): string {
  const yaml = dumpYaml(
    { title: chapterTitle.trim() },
    { lineWidth: -1 },
  ).trimEnd()
  const header = `---\n${yaml}\n---\n`
  return blocks.length ? `${header}\n${blocks.join('\n\n')}\n` : header
}

export function createCardUuid(): string {
  return uuidv4().replace(/-/g, '').slice(0, 8)
}

export function extractMarkdownBody(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

export async function collectExistingCardUuids(
  vault: LearningVaultReadApi,
  projectPath: string,
): Promise<Set<string>> {
  const prefix = `${normalizeLearningVaultPath(projectPath.replace(/\/$/, ''))}/`
  const uuids = new Set<string>()
  const files = vault
    .listMarkdownFiles()
    .filter((file) => file.name === 'cards.md' && file.path.startsWith(prefix))
  for (const file of files) {
    const content = await vault.readText(file.path)
    for (const match of content.matchAll(
      /<!--\s*card:([0-9a-fA-F]{8})(?:\s+kp:[0-9a-fA-F]{8})?\s*-->/g,
    )) {
      uuids.add((match[1] ?? '').toLowerCase())
    }
  }
  return uuids
}

/**
 * True when `cardsPath` exists and holds more than the empty
 * `buildCardsContent(chapterTitle, [])` shell — i.e. a chapter whose cards
 * stage actually produced cards, as opposed to one that was scaffolded but
 * never run. Used by generation resume to tell "cards missing" chapters
 * apart from "cards already generated" ones.
 */
export async function hasResumableCardsFile(
  host: Pick<LearningGenerationHost, 'vault' | 'vaultWriter'>,
  cardsPath: string,
  chapterTitle: string,
): Promise<boolean> {
  if (host.vault.getEntry(cardsPath)?.kind !== 'file') return false
  const existing = await host.vaultWriter.readTextSnapshot(cardsPath)
  return existing?.content !== buildCardsContent(chapterTitle, [])
}
