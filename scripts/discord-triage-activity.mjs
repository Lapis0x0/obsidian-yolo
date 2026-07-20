#!/usr/bin/env node

import process from 'node:process'

const DISCORD_API_BASE = 'https://discord.com/api/v10'
const DISCORD_EPOCH_MS = 1420070400000n

export const YOLO_DISCORD_IDS = Object.freeze({
  guild: '1526258702380699732',
  bot: '1526259168489508894',
  general: '1526264201436201011',
  helpForum: '1526264209506046056',
  ideasForum: '1526264211335024851',
})

const FORUM_IDS = new Set([
  YOLO_DISCORD_IDS.helpForum,
  YOLO_DISCORD_IDS.ideasForum,
])

export function snowflakeFromTimestamp(timestampMs) {
  const milliseconds = BigInt(Math.trunc(timestampMs))
  if (milliseconds < DISCORD_EPOCH_MS) {
    throw new Error('Timestamp predates the Discord epoch')
  }
  return ((milliseconds - DISCORD_EPOCH_MS) << 22n).toString()
}

export function timestampFromSnowflake(snowflake) {
  return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS)
}

export function isMessageInWindow(message, cursor, watermark) {
  if (
    !message ||
    message.author?.bot ||
    message.author?.id === YOLO_DISCORD_IDS.bot
  ) {
    return false
  }

  const id = BigInt(message.id)
  return id > BigInt(cursor) && id <= BigInt(watermark)
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (outputPath) {
    process.stdout.write(`Writing ${name} to GITHUB_OUTPUT\n`)
    return import('node:fs/promises').then(({ appendFile }) =>
      appendFile(outputPath, `${name}=${value}\n`, 'utf8'),
    )
  }
  process.stdout.write(`${name}=${value}\n`)
  return Promise.resolve()
}

function requireToken() {
  const token = process.env.YOLO_DISCORD_BOT_TOKEN?.trim()
  if (!token) {
    throw new Error('YOLO_DISCORD_BOT_TOKEN is required')
  }
  return token
}

function validateCursor(value) {
  const cursor = value?.trim()
  if (!cursor) return undefined
  if (!/^\d+$/.test(cursor)) {
    throw new Error('YOLO_DISCORD_TRIAGE_CURSOR must be a Discord snowflake')
  }
  return cursor
}

async function discordRequest(token, path, attempt = 0) {
  let response
  try {
    response = await fetch(`${DISCORD_API_BASE}${path}`, {
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent':
          'DiscordBot (https://github.com/Lapis0x0/obsidian-yolo, 1.0)',
      },
    })
  } catch (error) {
    if (attempt >= 3) throw error
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000))
    return discordRequest(token, path, attempt + 1)
  }

  if (response.status === 429 && attempt < 3) {
    const body = await response.json()
    const retryAfterMs = Math.ceil(Number(body.retry_after ?? 1) * 1000)
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs))
    return discordRequest(token, path, attempt + 1)
  }

  if (response.status >= 500 && attempt < 3) {
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000))
    return discordRequest(token, path, attempt + 1)
  }

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Discord API ${response.status} for ${path}: ${body.slice(0, 500)}`,
    )
  }

  return response.json()
}

async function listMessagesAfter(token, channelId, cursor) {
  const messages = []
  let after = cursor

  for (let page = 0; page < 50; page += 1) {
    const batch = await discordRequest(
      token,
      `/channels/${channelId}/messages?limit=100&after=${after}`,
    )
    if (!Array.isArray(batch) || batch.length === 0) break

    batch.sort((left, right) =>
      BigInt(left.id) < BigInt(right.id)
        ? -1
        : BigInt(left.id) > BigInt(right.id)
          ? 1
          : 0,
    )
    messages.push(...batch)
    after = batch.at(-1).id
    if (batch.length < 100) break
  }

  return messages
}

async function listRecentlyArchivedThreads(token, forumId, cursorTimestamp) {
  const threads = []
  let before

  for (let page = 0; page < 50; page += 1) {
    const query = new URLSearchParams({ limit: '100' })
    if (before) query.set('before', before)
    const result = await discordRequest(
      token,
      `/channels/${forumId}/threads/archived/public?${query}`,
    )
    const batch = Array.isArray(result.threads) ? result.threads : []
    if (batch.length === 0) break
    threads.push(...batch)

    const oldestArchiveTimestamp = batch
      .map((thread) => thread.thread_metadata?.archive_timestamp)
      .filter(Boolean)
      .sort()
      .at(0)
    if (
      !result.has_more ||
      !oldestArchiveTimestamp ||
      Date.parse(oldestArchiveTimestamp) <= cursorTimestamp
    ) {
      break
    }
    before = oldestArchiveTimestamp
  }

  return threads
}

async function listRelevantThreadIds(token, cursor) {
  const active = await discordRequest(
    token,
    `/guilds/${YOLO_DISCORD_IDS.guild}/threads/active`,
  )
  const cursorTimestamp = timestampFromSnowflake(cursor)
  const archived = await Promise.all(
    [...FORUM_IDS].map((forumId) =>
      listRecentlyArchivedThreads(token, forumId, cursorTimestamp),
    ),
  )

  return [
    ...(Array.isArray(active.threads) ? active.threads : []),
    ...archived.flat(),
  ]
    .filter((thread) => FORUM_IDS.has(thread.parent_id))
    .filter(
      (thread, index, all) =>
        all.findIndex((candidate) => candidate.id === thread.id) === index,
    )
    .map((thread) => thread.id)
}

async function hasNewExternalActivity(token, cursor, watermark) {
  const threadIds = await listRelevantThreadIds(token, cursor)
  const channelIds = [YOLO_DISCORD_IDS.general, ...threadIds]
  const messageGroups = await Promise.all(
    channelIds.map((channelId) => listMessagesAfter(token, channelId, cursor)),
  )

  return messageGroups.some((messages) =>
    messages.some((message) => isMessageInWindow(message, cursor, watermark)),
  )
}

export async function probeActivity({
  token = requireToken(),
  cursor = validateCursor(process.env.YOLO_DISCORD_TRIAGE_CURSOR),
  now = Date.now(),
  force = process.env.FORCE_DISCORD_TRIAGE === 'true',
} = {}) {
  const watermark = snowflakeFromTimestamp(now)

  if (!cursor) {
    return { initialized: true, hasActivity: false, cursor: '', watermark }
  }

  const hasActivity = force
    ? true
    : await hasNewExternalActivity(token, cursor, watermark)
  return { initialized: false, hasActivity, cursor, watermark }
}

async function main() {
  if (process.argv[1] !== new URL(import.meta.url).pathname) return
  if ((process.argv[2] ?? 'probe') !== 'probe') {
    throw new Error(`Unknown command: ${process.argv[2]}`)
  }

  const result = await probeActivity()
  await writeOutput('initialized', String(result.initialized))
  await writeOutput('has_activity', String(result.hasActivity))
  await writeOutput('cursor', result.cursor)
  await writeOutput('watermark', result.watermark)
  process.stdout.write(
    result.initialized
      ? 'Initialized Discord triage at the current message boundary.\n'
      : result.hasActivity
        ? 'New external Discord activity found.\n'
        : 'No new external Discord activity found.\n',
  )
}

await main()
