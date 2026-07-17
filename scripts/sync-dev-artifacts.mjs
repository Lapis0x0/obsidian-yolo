import { execFile } from 'node:child_process'
import { copyFile, readFile, rename, watch } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const sourceDir = process.cwd()
const artifactNames = new Set(['main.js', 'styles.css'])
const pendingTimers = new Map()
let copyChain = Promise.resolve()

async function resolvePluginDir() {
  const override = process.env.OBSIDIAN_PLUGIN_DIR?.trim()
  if (override) {
    return path.resolve(override)
  }

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

async function copyArtifact(pluginDir, artifactName) {
  const sourcePath = path.join(sourceDir, artifactName)
  const targetPath = path.join(pluginDir, artifactName)
  const temporaryPath = path.join(
    pluginDir,
    `.${artifactName}.${process.pid}.tmp`,
  )

  await copyFile(sourcePath, temporaryPath)
  await rename(temporaryPath, targetPath)
  console.log(`[dev-sync] ${artifactName}`)
}

function scheduleCopy(pluginDir, artifactName) {
  const previousTimer = pendingTimers.get(artifactName)
  if (previousTimer) {
    clearTimeout(previousTimer)
  }

  pendingTimers.set(
    artifactName,
    setTimeout(() => {
      pendingTimers.delete(artifactName)
      copyChain = copyChain
        .then(() => copyArtifact(pluginDir, artifactName))
        .catch((error) => {
          console.error(`[dev-sync] Failed to copy ${artifactName}:`, error)
        })
    }, 100),
  )
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
if (process.argv.includes('--once')) {
  await Promise.all(
    [...artifactNames].map((artifactName) =>
      copyArtifact(pluginDir, artifactName),
    ),
  )
  process.exit(0)
}

for (const artifactName of artifactNames) {
  scheduleCopy(pluginDir, artifactName)
}

const watcher = watch(sourceDir)
for await (const event of watcher) {
  const artifactName = event.filename?.toString()
  if (artifactName && artifactNames.has(artifactName)) {
    scheduleCopy(pluginDir, artifactName)
  }
}
