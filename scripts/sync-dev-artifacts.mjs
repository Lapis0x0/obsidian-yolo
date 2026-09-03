import { execFile } from 'node:child_process'
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  watch,
} from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const sourceDir = process.cwd()
const staticArtifacts = new Set([
  'main.js',
  'styles.css',
  'modules/bundled.json',
])
const pendingTimers = new Map()
let copyChain = Promise.resolve()

async function resolvePluginDir() {
  const override = process.env.OBSIDIAN_PLUGIN_DIR?.trim()
  if (override) return path.resolve(override)

  const { stdout } = await execFileAsync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: sourceDir },
  )
  return path.dirname(stdout.trim())
}

async function readPluginId(directory) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, 'manifest.json'), 'utf8'),
  )
  return manifest.id
}

async function pathExists(value) {
  try {
    await stat(value)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function discoverModuleVersionDirs() {
  const modulesRoot = path.join(sourceDir, 'modules')
  const moduleEntries = await readdir(modulesRoot, { withFileTypes: true })
  const versions = []
  for (const moduleEntry of moduleEntries) {
    if (!moduleEntry.isDirectory() || moduleEntry.name.startsWith('.')) continue
    const moduleRoot = path.join(modulesRoot, moduleEntry.name)
    const versionEntries = await readdir(moduleRoot, { withFileTypes: true })
    for (const versionEntry of versionEntries) {
      if (!versionEntry.isDirectory() || versionEntry.name.startsWith('.')) {
        continue
      }
      const relativeDir = path.posix.join(
        'modules',
        moduleEntry.name,
        versionEntry.name,
      )
      if (await pathExists(path.join(sourceDir, relativeDir, 'module.json'))) {
        versions.push(relativeDir)
      }
    }
  }
  return versions.sort()
}

async function copyArtifact(pluginDir, artifactName) {
  const sourcePath = path.join(sourceDir, artifactName)
  const targetPath = path.join(pluginDir, artifactName)
  const targetDir = path.dirname(targetPath)
  const temporaryPath = path.join(
    targetDir,
    `.${path.basename(artifactName)}.${process.pid}.tmp`,
  )

  await mkdir(targetDir, { recursive: true })
  await cp(sourcePath, temporaryPath, { force: true })
  await rename(temporaryPath, targetPath)
  console.log(`[dev-sync] ${artifactName}`)
}

async function copyModuleVersion(pluginDir, relativeDir) {
  const sourcePath = path.join(sourceDir, relativeDir)
  const targetPath = path.join(pluginDir, relativeDir)
  const targetParent = path.dirname(targetPath)
  const baseName = path.basename(targetPath)
  const temporaryPath = path.join(
    targetParent,
    `.${baseName}.${process.pid}.tmp`,
  )
  const backupPath = path.join(
    targetParent,
    `.${baseName}.${process.pid}.backup`,
  )

  await mkdir(targetParent, { recursive: true })
  await rm(temporaryPath, { recursive: true, force: true })
  await rm(backupPath, { recursive: true, force: true })
  await cp(sourcePath, temporaryPath, { recursive: true, force: true })
  const hadTarget = await pathExists(targetPath)
  if (hadTarget) await rename(targetPath, backupPath)
  try {
    await rename(temporaryPath, targetPath)
  } catch (error) {
    if (hadTarget && !(await pathExists(targetPath))) {
      await rename(backupPath, targetPath)
    }
    throw error
  }
  await rm(backupPath, { recursive: true, force: true })
  console.log(`[dev-sync] ${relativeDir}`)
}

function schedule(key, operation) {
  const previousTimer = pendingTimers.get(key)
  if (previousTimer) clearTimeout(previousTimer)

  pendingTimers.set(
    key,
    setTimeout(() => {
      pendingTimers.delete(key)
      copyChain = copyChain.then(operation).catch((error) => {
        console.error(`[dev-sync] Failed to copy ${key}:`, error)
      })
    }, 100),
  )
}

/** A `modules/<id>/<version>/module.json` that we do not already sync — the
 * one shape that means "a module version directory appeared after we looked". */
const NEW_MODULE_MANIFEST = /^modules\/[^/]+\/[^/]+\/module\.json$/
const warnedNewVersionDirs = new Set()

const pluginDir = await resolvePluginDir()
if (path.resolve(pluginDir) === path.resolve(sourceDir)) {
  console.log(
    '[dev-sync] Main worktree already is the Obsidian plugin directory',
  )
  process.exit(0)
}

const [sourcePluginId, targetPluginId] = await Promise.all([
  readPluginId(sourceDir),
  readPluginId(pluginDir),
])
if (sourcePluginId !== targetPluginId) {
  throw new Error(
    `Plugin id mismatch: source=${sourcePluginId}, target=${targetPluginId}`,
  )
}

console.log(`[dev-sync] ${sourceDir} -> ${pluginDir}`)
const moduleVersionDirs = await discoverModuleVersionDirs()
if (process.argv.includes('--once')) {
  await Promise.all([
    ...[...staticArtifacts].map((artifact) =>
      copyArtifact(pluginDir, artifact),
    ),
    ...moduleVersionDirs.map((directory) =>
      copyModuleVersion(pluginDir, directory),
    ),
  ])
  process.exit(0)
}

for (const artifact of staticArtifacts) {
  schedule(artifact, () => copyArtifact(pluginDir, artifact))
}
for (const directory of moduleVersionDirs) {
  schedule(directory, () => copyModuleVersion(pluginDir, directory))
}

/**
 * Which directory we already sync this changed path belongs to, or null.
 *
 * A lookup against the list discovered at startup, and deliberately never a
 * derivation from the path itself. `copyModuleVersion` renames its target
 * aside and then deletes it, and — when this runs from a worktree — that
 * target is inside the *main* working tree. So whatever computes the target
 * is not a copy routine, it is a delete routine, and the only safe input is a
 * directory we have already confirmed is a module version
 * (`discoverModuleVersionDirs` requires a `module.json` in it).
 *
 * This used to slice the first three segments off the changed path instead,
 * which cannot tell `modules/whiteboard/0.1.1` from `modules/whiteboard/src`:
 * editing any module source made the watcher replace the main tree's copy of
 * that module's *source directory* with this worktree's, destroying whatever
 * uncommitted work was in it. Matching the way the static artifacts above
 * already do — exact membership of a set fixed at startup — is what makes
 * that class of mistake unreachable rather than merely fixed.
 */
function syncedDirectoryFor(filename) {
  return (
    moduleVersionDirs.find(
      (directory) =>
        filename === directory || filename.startsWith(`${directory}/`),
    ) ?? null
  )
}

const watcher = watch(sourceDir, { recursive: true })
for await (const event of watcher) {
  const filename = event.filename?.toString().replaceAll('\\', '/')
  if (!filename) continue
  if (staticArtifacts.has(filename)) {
    schedule(filename, () => copyArtifact(pluginDir, filename))
    continue
  }
  const directory = syncedDirectoryFor(filename)
  if (directory) {
    schedule(directory, () => copyModuleVersion(pluginDir, directory))
    continue
  }
  // The list is read once, at startup, so a version directory created since
  // then is not synced. Said out loud rather than passed over in silence —
  // this is the one case where doing nothing is not what the user wanted —
  // and only for the manifest that marks such a directory, because module
  // sources change on every keystroke and must stay quiet.
  if (NEW_MODULE_MANIFEST.test(filename)) {
    const directory = filename.slice(0, filename.lastIndexOf('/'))
    if (!warnedNewVersionDirs.has(directory)) {
      warnedNewVersionDirs.add(directory)
      console.log(
        `[dev-sync] ${directory} appeared after startup and is not being synced — restart dev-sync to pick it up`,
      )
    }
  }
}
