import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const MAX_EMBED_DESCRIPTION_LENGTH = 3900
const DISCORD_EMBED_COLOR = 0x5865f2

export function splitDiscordMarkdown(
  markdown,
  maxLength = MAX_EMBED_DESCRIPTION_LENGTH,
) {
  const chunks = []
  let remaining = markdown.trim()

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLength)
    if (splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf('\n', maxLength)
    }
    if (splitAt <= 0) {
      splitAt = maxLength
      const previousCodeUnit = remaining.charCodeAt(splitAt - 1)
      if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) {
        splitAt -= 1
      }
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }

  if (remaining) {
    chunks.push(remaining)
  }

  return chunks
}

export function getEnglishReleaseNotes(markdown) {
  return markdown.split(/^[ \t]*---[ \t]*$/m, 1)[0].trim()
}

function requireEnvironmentVariable(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function normalizeDiscordWebhookUrl(value) {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'discord.com' ||
    !url.pathname.startsWith('/api/webhooks/')
  ) {
    throw new Error('DISCORD_RELEASE_WEBHOOK_URL is not a Discord webhook URL')
  }
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function buildPayload({ chunk, index, releaseTag, releaseUrl, total }) {
  return {
    username: 'YOLO Releases',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title:
          total === 1
            ? `YOLO ${releaseTag}`
            : `YOLO ${releaseTag} (${index + 1}/${total})`,
        url: releaseUrl,
        description: chunk,
        color: DISCORD_EMBED_COLOR,
      },
    ],
  }
}

async function executeWebhook({ endpoint, method, payload }) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (response.ok) {
        return
      }
      lastError = new Error(
        `Discord webhook request failed with HTTP ${response.status}`,
      )
    } catch (error) {
      lastError = error
    }

    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
    }
  }

  throw lastError
}

export async function notifyDiscordRelease() {
  const releaseTag = requireEnvironmentVariable('RELEASE_TAG')
  const releaseUrl = requireEnvironmentVariable('RELEASE_URL')
  const releaseNotesPath =
    process.env.RELEASE_NOTES_PATH?.trim() || 'latest-release-note.md'
  const releaseNotes = getEnglishReleaseNotes(
    await readFile(releaseNotesPath, 'utf8'),
  )
  const chunks = splitDiscordMarkdown(releaseNotes)
  if (chunks.length === 0) {
    throw new Error('Release notes are empty')
  }

  if (process.env.DISCORD_DRY_RUN === '1') {
    console.log(
      JSON.stringify({
        releaseTag,
        chunkCount: chunks.length,
        chunkLengths: chunks.map((chunk) => chunk.length),
      }),
    )
    return
  }

  const webhookUrl = normalizeDiscordWebhookUrl(
    requireEnvironmentVariable('DISCORD_RELEASE_WEBHOOK_URL'),
  )
  const existingMessageId = process.env.DISCORD_MESSAGE_ID?.trim()

  for (const [index, chunk] of chunks.entries()) {
    const shouldEditExistingMessage = index === 0 && existingMessageId
    const endpoint = shouldEditExistingMessage
      ? `${webhookUrl}/messages/${encodeURIComponent(existingMessageId)}`
      : `${webhookUrl}?wait=true`
    await executeWebhook({
      endpoint,
      method: shouldEditExistingMessage ? 'PATCH' : 'POST',
      payload: buildPayload({
        chunk,
        index,
        releaseTag,
        releaseUrl,
        total: chunks.length,
      }),
    })
  }

  console.log(
    existingMessageId
      ? `Updated Discord release notification in ${chunks.length} message(s).`
      : `Sent Discord release notification in ${chunks.length} message(s).`,
  )
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  await notifyDiscordRelease()
}
