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

function moduleVersionDir(filename) {
  const parts = filename.replaceAll('\\', '/').split('/')
  return parts[0] === 'modules' && parts.length >= 4
    ? parts.slice(0, 3).join('/')
    : null
}

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

const watcher = watch(sourceDir, { recursive: true })
for await (const event of watcher) {
  const filename = event.filename?.toString().replaceAll('\\', '/')
  if (!filename) continue
  if (staticArtifacts.has(filename)) {
    schedule(filename, () => copyArtifact(pluginDir, filename))
    continue
  }
  const directory = moduleVersionDir(filename)
  if (directory) {
    schedule(directory, () => copyModuleVersion(pluginDir, directory))
  }
}
