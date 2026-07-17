import { type DataAdapter, normalizePath } from 'obsidian'

import type YoloPlugin from '../../main'

import { normalizePluginVersion } from './updateChecker'

export const RELEASE_FILE_NAMES = {
  mainJs: 'main.js',
  manifestJson: 'manifest.json',
  stylesCss: 'styles.css',
} as const

export type ReleaseFileName =
  (typeof RELEASE_FILE_NAMES)[keyof typeof RELEASE_FILE_NAMES]

export type InstallationIssueReason =
  | 'version_mismatch'
  | 'missing_file'
  | 'empty_file'
  | 'invalid_manifest'

export type InstallationIncompleteDetail = {
  targetVersion: string
  mainVersion: string | null
  manifestVersion: string
  stylesVersion: string | null
  reasons: InstallationIssueReason[]
  suspectFiles: ReleaseFileName[]
}

const MAIN_JS_MIN_BYTES = 1024

const STYLES_VERSION_RE =
  /^\/\*\s*@yolo-version:\s*([^\s*]+)\s*\*\/\s*(?:\r?\n)?/

export function parseStylesBakedVersion(css: string): string | null {
  const match = css.match(STYLES_VERSION_RE)
  if (!match?.[1]) {
    return null
  }
  const normalized = normalizePluginVersion(match[1])
  return normalized || null
}

function addSuspect(
  suspectFiles: Set<ReleaseFileName>,
  reasons: Set<InstallationIssueReason>,
  file: ReleaseFileName,
  reason: InstallationIssueReason,
): void {
  suspectFiles.add(file)
  reasons.add(reason)
}

function resolveTargetVersion(params: {
  mainVersion: string | null
  manifestVersion: string
  stylesVersion: string | null
}): string {
  const { mainVersion, manifestVersion, stylesVersion } = params
  const manifestNormalized = normalizePluginVersion(manifestVersion)
  const votes = new Map<string, number>()

  for (const version of [mainVersion, manifestNormalized, stylesVersion]) {
    if (!version) {
      continue
    }
    const normalized = normalizePluginVersion(version)
    if (!normalized) {
      continue
    }
    votes.set(normalized, (votes.get(normalized) ?? 0) + 1)
  }

  let targetVersion = manifestNormalized
  let maxVotes = 0
  for (const [version, count] of votes) {
    if (count > maxVotes) {
      maxVotes = count
      targetVersion = version
    }
  }

  return targetVersion
}

function collectVersionMismatchSuspects(params: {
  mainVersion: string | null
  manifestVersion: string
  stylesVersion: string | null
  targetVersion: string
  suspectFiles: Set<ReleaseFileName>
  reasons: Set<InstallationIssueReason>
}): void {
  const { targetVersion, suspectFiles, reasons } = params
  const target = normalizePluginVersion(targetVersion)
  const checks: Array<{ file: ReleaseFileName; version: string | null }> = [
    { file: RELEASE_FILE_NAMES.mainJs, version: params.mainVersion },
    {
      file: RELEASE_FILE_NAMES.manifestJson,
      version: normalizePluginVersion(params.manifestVersion),
    },
    { file: RELEASE_FILE_NAMES.stylesCss, version: params.stylesVersion },
  ]

  const known = checks.filter((entry) => entry.version)
  if (known.length < 2) {
    return
  }

  for (const entry of known) {
    if (normalizePluginVersion(entry.version!) !== target) {
      addSuspect(suspectFiles, reasons, entry.file, 'version_mismatch')
    }
  }
}

async function readFileSize(
  adapter: DataAdapter,
  path: string,
): Promise<number | null> {
  try {
    const stat = await adapter.stat(path)
    if (!stat || stat.type !== 'file') {
      return null
    }
    return stat.size
  } catch {
    return null
  }
}

export async function checkInstallationIntegrityLayer1And2(
  plugin: YoloPlugin,
  bakedMainVersion: string | null,
): Promise<InstallationIncompleteDetail | null> {
  const pluginDir = plugin.manifest.dir
  if (!pluginDir) {
    return null
  }

  const adapter = plugin.app.vault.adapter
  const suspectFiles = new Set<ReleaseFileName>()
  const reasons = new Set<InstallationIssueReason>()

  const mainPath = normalizePath(`${pluginDir}/${RELEASE_FILE_NAMES.mainJs}`)
  const manifestPath = normalizePath(
    `${pluginDir}/${RELEASE_FILE_NAMES.manifestJson}`,
  )
  const stylesPath = normalizePath(
    `${pluginDir}/${RELEASE_FILE_NAMES.stylesCss}`,
  )

  const mainExists = await adapter.exists(mainPath)
  if (!mainExists) {
    addSuspect(suspectFiles, reasons, RELEASE_FILE_NAMES.mainJs, 'missing_file')
  } else {
    const mainSize = await readFileSize(adapter, mainPath)
    if (mainSize === null || mainSize < MAIN_JS_MIN_BYTES) {
      addSuspect(suspectFiles, reasons, RELEASE_FILE_NAMES.mainJs, 'empty_file')
    }
  }

  const manifestExists = await adapter.exists(manifestPath)
  let manifestVersion = normalizePluginVersion(plugin.manifest.version)
  if (!manifestExists) {
    addSuspect(
      suspectFiles,
      reasons,
      RELEASE_FILE_NAMES.manifestJson,
      'missing_file',
    )
  } else {
    const manifestSize = await readFileSize(adapter, manifestPath)
    if (manifestSize === null || manifestSize <= 0) {
      addSuspect(
        suspectFiles,
        reasons,
        RELEASE_FILE_NAMES.manifestJson,
        'empty_file',
      )
    } else {
      try {
        const raw = await adapter.read(manifestPath)
        const parsed = JSON.parse(raw) as { version?: unknown }
        const diskVersion =
          typeof parsed.version === 'string'
            ? normalizePluginVersion(parsed.version)
            : ''
        if (!diskVersion) {
          addSuspect(
            suspectFiles,
            reasons,
            RELEASE_FILE_NAMES.manifestJson,
            'invalid_manifest',
          )
        } else {
          manifestVersion = diskVersion
        }
      } catch {
        addSuspect(
          suspectFiles,
          reasons,
          RELEASE_FILE_NAMES.manifestJson,
          'invalid_manifest',
        )
      }
    }
  }

  const stylesExists = await adapter.exists(stylesPath)
  let stylesVersion: string | null = null
  if (!stylesExists) {
    addSuspect(
      suspectFiles,
      reasons,
      RELEASE_FILE_NAMES.stylesCss,
      'missing_file',
    )
  } else {
    const stylesSize = await readFileSize(adapter, stylesPath)
    if (stylesSize === null || stylesSize <= 0) {
      addSuspect(
        suspectFiles,
        reasons,
        RELEASE_FILE_NAMES.stylesCss,
        'empty_file',
      )
    } else {
      try {
        const stylesRaw = await adapter.read(stylesPath)
        stylesVersion = parseStylesBakedVersion(stylesRaw)
      } catch {
        addSuspect(
          suspectFiles,
          reasons,
          RELEASE_FILE_NAMES.stylesCss,
          'empty_file',
        )
      }
    }
  }

  const mainVersion = bakedMainVersion
    ? normalizePluginVersion(bakedMainVersion)
    : null

  const targetVersion = resolveTargetVersion({
    mainVersion,
    manifestVersion,
    stylesVersion,
  })

  collectVersionMismatchSuspects({
    mainVersion,
    manifestVersion,
    stylesVersion,
    targetVersion,
    suspectFiles,
    reasons,
  })

  if (suspectFiles.size === 0) {
    return null
  }

  return {
    targetVersion,
    mainVersion,
    manifestVersion,
    stylesVersion,
    reasons: [...reasons],
    suspectFiles: [...suspectFiles],
  }
}
