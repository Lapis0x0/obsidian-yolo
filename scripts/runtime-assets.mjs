/**
 * Manages the permanent, append-only `runtime-assets` Release that holds
 * every runtime component artifact. See
 * `runtimeComponentReleaseAssets.mjs` for why it exists and why each
 * attachment is named `{sha256}-{name}`.
 *
 *   node scripts/runtime-assets.mjs publish [--dry-run]
 *     Uploads any artifact the local registry declares that isn't already
 *     attached. Idempotent by construction: an artifact whose bytes haven't
 *     changed has the same name and is skipped, so the usual Core release
 *     uploads nothing. Creates the Release on first run.
 *
 *   node scripts/runtime-assets.mjs audit [--json]
 *     Completeness check. Walks every numeric version tag in the repository,
 *     reads the `registry.json` committed at that tag, and asserts that every
 *     artifact any shipped version can ask for is actually attached.
 *
 *     The two sources are held to different standards on purpose. The
 *     Release is the durable, complete store and must hold everything.
 *     The R2 mirror is a latest-only snapshot (`build-pages` rebuilds it for
 *     the current version alone), so it is checked only for what the newest
 *     version references — a superseded artifact missing from R2 is the
 *     design working, with those users falling back to the Release.
 *
 *     This direction is the one that matters. Nothing is ever deleted, so
 *     stale artifacts are harmless (the entire history to date is ~20 MB, and
 *     Release attachments are free and unmetered for public repositories).
 *     A *missing* artifact, by contrast, is a silent 404 for everyone still
 *     running the version that baked its hash — no error, no crash report,
 *     just "it won't install" from a shrinking group of users. Artifacts no
 *     longer referenced by any tag are reported for information only; they
 *     are never a failure, and deleting one is how you create the outage
 *     this command exists to prevent.
 *
 *   node scripts/runtime-assets.mjs backfill [--dry-run]
 *     Repairs whatever `audit` reports missing, reading the bytes out of Git
 *     at a tag that references them and verifying against that tag's declared
 *     hash before uploading. This works for artifacts from before `dist/`
 *     became gitignored, which is exactly the one-time migration case; a
 *     newer artifact that is somehow missing has to be rebuilt from its tag
 *     and pushed with `publish`.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import {
  RUNTIME_ASSET_TAG,
  listRegistryRuntimeAssets,
  listRuntimeComponentReleaseAssets,
} from './runtimeComponentReleaseAssets.mjs'

const REPOSITORY = process.env.GITHUB_REPOSITORY || 'Lapis0x0/obsidian-yolo'
const MIRROR_BASE = 'https://updates.yoloapp.dev/runtime-components/sha256'
const VERSION_TAG = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2,3}$/

const RELEASE_BODY = `Permanent, content-addressed store for YOLO runtime component artifacts.

Every attachment is named \`{sha256}-{filename}\` and is referenced by the
\`registry.json\` baked into one or more published Core versions, which verify
the bytes against that hash on download.

**Never delete or replace an attachment here.** Superseded artifacts are still
requested by already-shipped Core versions; removing one breaks component
installation for those users with a silent 404. This Release is append-only.`

export async function fetchReleaseAssetNames(options = {}) {
  const release = await githubJson(
    `/repos/${options.repository ?? REPOSITORY}/releases/tags/${RUNTIME_ASSET_TAG}`,
    options,
    { allow404: true },
  )
  if (!release) return null
  if (!Array.isArray(release.assets)) {
    throw new Error(`${RUNTIME_ASSET_TAG} Release assets are invalid`)
  }
  return {
    id: release.id,
    names: new Set(release.assets.map((asset) => asset.name)),
  }
}

/**
 * The referenced set is derived entirely from Git: every published version
 * committed the `registry.json` it shipped with, so the union of those
 * registries across all version tags is exactly the set of artifacts any
 * released client can ask for. No separate ledger to maintain or drift.
 */
export function collectReferencedRuntimeAssets(options = {}) {
  const run = options.git ?? git
  const tags = run(['tag'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => VERSION_TAG.test(line))
    .sort(compareVersions)
  const referenced = new Map()
  for (const tag of tags) {
    let registry
    try {
      registry = JSON.parse(
        run(['show', `${tag}:runtime-components/registry.json`]),
      )
    } catch {
      // Versions predating runtime components have no registry at all.
      continue
    }
    for (const entry of listRegistryRuntimeAssets(registry)) {
      const existing = referenced.get(entry.releaseName)
      if (existing) {
        existing.tags.push(tag)
        continue
      }
      referenced.set(entry.releaseName, { ...entry, tags: [tag] })
    }
  }
  return referenced
}

async function publish(args) {
  const dryRun = args.includes('--dry-run')
  const declared = await listRuntimeComponentReleaseAssets()
  let release = await fetchReleaseAssetNames()
  if (!release) {
    if (dryRun) {
      console.log(`Would create Release ${RUNTIME_ASSET_TAG}`)
      release = { id: null, names: new Set() }
    } else {
      release = { id: await createReleaseShell(), names: new Set() }
      console.log(`Created Release ${RUNTIME_ASSET_TAG}`)
    }
  }
  const missing = declared.filter(
    (entry) => !release.names.has(entry.releaseName),
  )
  for (const entry of declared) {
    if (!missing.includes(entry)) {
      console.log(
        `Present  ${entry.componentId}/${entry.name} ${short(entry.sha256)}`,
      )
    }
  }
  for (const entry of missing) {
    const bytes = await readFile(entry.sourcePath)
    assertBytes(bytes, entry)
    if (dryRun) {
      console.log(
        `Would upload ${entry.componentId}/${entry.name} ${short(entry.sha256)}`,
      )
      continue
    }
    await uploadAsset(release.id, entry.releaseName, bytes)
    console.log(
      `Uploaded ${entry.componentId}/${entry.name} ${short(entry.sha256)}`,
    )
  }
  if (missing.length === 0) {
    console.log(`${RUNTIME_ASSET_TAG} already holds every declared artifact`)
  }
}

async function audit(args) {
  const asJson = args.includes('--json')
  const skipMirror = args.includes('--skip-mirror')
  const referenced = collectReferencedRuntimeAssets()
  const release = await fetchReleaseAssetNames()
  if (!release) {
    throw new Error(`Release ${RUNTIME_ASSET_TAG} does not exist`)
  }
  const latest = latestTag(referenced)
  const missing = []
  const mirrorMissing = []
  for (const entry of referenced.values()) {
    if (!release.names.has(entry.releaseName)) {
      missing.push(entry)
      continue
    }
    if (skipMirror || !entry.tags.includes(latest)) continue
    if (!(await mirrorHas(entry))) mirrorMissing.push(entry)
  }
  const orphaned = [...release.names].filter((name) => !referenced.has(name))
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          referenced: [...referenced.values()].map((entry) => ({
            componentId: entry.componentId,
            name: entry.name,
            sha256: entry.sha256,
            tags: entry.tags,
          })),
          missing: missing.map((entry) => entry.releaseName),
          mirrorMissing: mirrorMissing.map((entry) => entry.releaseName),
          orphaned,
        },
        null,
        2,
      ),
    )
  } else {
    for (const entry of referenced.values()) {
      const where = release.names.has(entry.releaseName) ? 'ok     ' : 'MISSING'
      const current = entry.tags.includes(latest) ? ' current' : ''
      console.log(
        `${where} ${entry.componentId.padEnd(18)}${entry.name.padEnd(30)}${short(entry.sha256)}  ${entry.tags.length} version(s)  ${entry.tags[0]} → ${entry.tags[entry.tags.length - 1]}${current}`,
      )
    }
    for (const name of orphaned) {
      console.log(`unreferenced (kept) ${name}`)
    }
  }
  if (missing.length > 0 || mirrorMissing.length > 0) {
    for (const entry of missing) {
      console.error(
        `::error::${RUNTIME_ASSET_TAG} is missing ${entry.releaseName}, needed by ${entry.tags.join(', ')}`,
      )
    }
    for (const entry of mirrorMissing) {
      console.error(
        `::error::R2 mirror is missing ${entry.sha256}/${entry.name}, referenced by the current version ${latest}`,
      )
    }
    throw new Error('Runtime component artifacts are not fully published')
  }
  console.log(
    `Verified ${referenced.size} referenced artifact(s) on ${RUNTIME_ASSET_TAG}${skipMirror ? '' : `, and ${latest}'s on the mirror`}; ${orphaned.length} unreferenced attachment(s) retained`,
  )
}

async function backfill(args) {
  const dryRun = args.includes('--dry-run')
  const referenced = collectReferencedRuntimeAssets()
  const release = await fetchReleaseAssetNames()
  if (!release) throw new Error(`Release ${RUNTIME_ASSET_TAG} does not exist`)
  const missing = [...referenced.values()].filter(
    (entry) => !release.names.has(entry.releaseName),
  )
  if (missing.length === 0) {
    console.log(`${RUNTIME_ASSET_TAG} already holds every referenced artifact`)
    return
  }
  for (const entry of missing) {
    const bytes = readFromGit(entry)
    if (!bytes) {
      throw new Error(
        `${entry.componentId}/${entry.name} ${short(entry.sha256)} is not in Git at ${entry.tags[0]} — rebuild it from that tag and run "publish"`,
      )
    }
    assertBytes(bytes, entry)
    if (dryRun) {
      console.log(
        `Would upload ${entry.componentId}/${entry.name} ${short(entry.sha256)} from ${entry.tags[0]}`,
      )
      continue
    }
    await uploadAsset(release.id, entry.releaseName, bytes)
    console.log(
      `Uploaded ${entry.componentId}/${entry.name} ${short(entry.sha256)} from ${entry.tags[0]}`,
    )
  }
}

/**
 * Artifacts released before `dist/` was gitignored are still committed at
 * their own tags, so the bytes are recoverable. `assertBytes` re-verifies
 * them against the hash that tag declared, so a wrong path or a rewritten
 * tag fails loudly rather than seeding the store with bad bytes.
 */
function readFromGit(entry) {
  for (const tag of entry.tags) {
    const result = spawnSync('git', ['show', `${tag}:${entry.repoPath}`], {
      maxBuffer: 256 * 1024 * 1024,
    })
    if (result.status === 0) return result.stdout
  }
  return null
}

/** The newest version any referenced artifact belongs to. */
function latestTag(referenced) {
  const tags = new Set()
  for (const entry of referenced.values()) {
    for (const tag of entry.tags) tags.add(tag)
  }
  return [...tags].sort(compareVersions).pop()
}

async function mirrorHas(entry) {
  const response = await fetch(`${MIRROR_BASE}/${entry.sha256}/${entry.name}`, {
    method: 'HEAD',
  })
  return response.ok
}

async function createReleaseShell() {
  const release = await githubJson(
    `/repos/${REPOSITORY}/releases`,
    {},
    {
      method: 'POST',
      body: {
        tag_name: RUNTIME_ASSET_TAG,
        name: 'Runtime component artifacts',
        body: RELEASE_BODY,
        // Never the "Latest" Release: this is a byte store, not a version.
        prerelease: true,
        draft: false,
      },
    },
  )
  return release.id
}

async function uploadAsset(releaseId, name, bytes) {
  const response = await fetch(
    `https://uploads.github.com/repos/${REPOSITORY}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${requireToken()}`,
        'Content-Type': 'application/octet-stream',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: bytes,
    },
  )
  if (!response.ok) {
    throw new Error(
      `Uploading ${name} failed with HTTP ${response.status}: ${await response.text()}`,
    )
  }
}

async function githubJson(pathname, options = {}, extra = {}) {
  const response = await (options.fetchImpl ?? fetch)(
    `https://api.github.com${pathname}`,
    {
      method: extra.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${requireToken()}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(extra.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(extra.body ? { body: JSON.stringify(extra.body) } : {}),
    },
  )
  if (extra.allow404 && response.status === 404) return null
  if (!response.ok) {
    throw new Error(
      `${extra.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}`,
    )
  }
  return JSON.parse(await response.text())
}

function requireToken() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) throw new Error('GH_TOKEN is required')
  return token
}

function assertBytes(bytes, entry) {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength !== entry.byteSize || sha256 !== entry.sha256) {
    throw new Error(
      `Local ${entry.componentId}/${entry.name} does not match the registry — run "npm run runtime:build"`,
    )
  }
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim())
  return result.stdout
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function short(sha256) {
  return sha256.slice(0, 10)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, ...args] = process.argv.slice(2)
  const commands = { publish, audit, backfill }
  try {
    if (!commands[command]) {
      throw new Error(
        'Usage: runtime-assets.mjs <publish|audit|backfill> [--dry-run|--json|--skip-mirror]',
      )
    }
    await commands[command](args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
