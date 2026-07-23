import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CORE_VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2,3}$/
const MODULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MODULE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const SCHEMA_NAMESPACE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const DANGEROUS_NAMES = new Set(['__proto__', 'prototype', 'constructor'])

export async function prepareRelease(root, product, id, version) {
  if (product === 'core') {
    assertCoreVersion(id)
    if (version !== undefined) throw new Error('Core release has one version')
    const targetVersion = id
    const manifest = await readJson(root, 'manifest.json')
    const packageJson = await readJson(root, 'package.json')
    const versions = await readJson(root, 'versions.json')
    assertString(manifest.minAppVersion, 'manifest minAppVersion')
    manifest.version = targetVersion
    packageJson.version = targetVersion
    versions[targetVersion] = manifest.minAppVersion
    await Promise.all([
      writeJson(root, 'manifest.json', manifest),
      writeJson(root, 'package.json', packageJson),
      writeJson(root, 'versions.json', versions),
    ])
    return { product, version: targetVersion, tag: targetVersion }
  }

  if (product !== 'module') throw new Error(`Unknown product: ${product}`)
  assertModuleId(id)
  assertModuleVersion(version)
  const config = await readJson(root, `modules/${id}/module.config.json`)
  if (config.id !== id) throw new Error(`Module config id must be ${id}`)
  const packagePath = `modules/${id}/package.json`
  const packageJson = await readJson(root, packagePath)
  packageJson.version = version
  await writeJson(root, packagePath, packageJson)
  return { product, id, version, tag: `${id}/v${version}` }
}

export async function checkRelease(root, product, id, version) {
  const target = normalizeTarget(product, id, version)
  if (target.product === 'core') {
    const [manifest, packageJson, versions, note] = await Promise.all([
      readJson(root, 'manifest.json'),
      readJson(root, 'package.json'),
      readJson(root, 'versions.json'),
      readText(root, 'latest-release-note.md'),
    ])
    if (
      manifest.version !== target.version ||
      packageJson.version !== target.version ||
      versions[target.version] !== manifest.minAppVersion
    ) {
      throw new Error('Core version sources are not synchronized')
    }
    validateReleaseNote(note, target.version)
  } else {
    const [config, packageJson, note] = await Promise.all([
      readJson(root, `modules/${target.id}/module.config.json`),
      readJson(root, `modules/${target.id}/package.json`),
      readText(root, `modules/${target.id}/latest-release-note.md`),
    ])
    validateModuleConfig(config, target.id)
    if (packageJson.version !== target.version) {
      throw new Error(`${target.id} package version is not synchronized`)
    }
    validateReleaseNote(note, target.version)
  }
  return target
}

function normalizeTarget(product, id, version) {
  if (product === 'core') {
    assertCoreVersion(id)
    if (version !== undefined) throw new Error('Core release has one version')
    return { product, version: id, tag: id }
  }
  if (product !== 'module') throw new Error(`Unknown product: ${product}`)
  assertModuleId(id)
  assertModuleVersion(version)
  return { product, id, version, tag: `${id}/v${version}` }
}

export function validateModuleConfig(config, expectedId) {
  if (
    config.id !== expectedId ||
    typeof config.icon !== 'string' ||
    !config.icon ||
    !isPlainRecord(config.localizations) ||
    Object.keys(config.localizations).length === 0 ||
    typeof config.hostApi !== 'string' ||
    !Array.isArray(config.platforms) ||
    config.platforms.length === 0 ||
    config.platforms.some(
      (platform) => platform !== 'desktop' && platform !== 'mobile',
    ) ||
    !isPlainRecord(config.dataSchemas) ||
    Object.keys(config.dataSchemas).length === 0
  ) {
    throw new Error(`Module config is invalid: ${expectedId}`)
  }
  for (const locale of Object.values(config.localizations)) {
    if (
      !isPlainRecord(locale) ||
      typeof locale.name !== 'string' ||
      !locale.name ||
      typeof locale.description !== 'string' ||
      !locale.description
    ) {
      throw new Error(`Module localization is invalid: ${expectedId}`)
    }
  }
  for (const [namespace, value] of Object.entries(config.dataSchemas)) {
    if (
      !SCHEMA_NAMESPACE.test(namespace) ||
      DANGEROUS_NAMES.has(namespace) ||
      !isPlainRecord(value) ||
      !hasExactKeys(value, ['readMin', 'readMax', 'write']) ||
      !isSchemaVersion(value.readMin) ||
      !isSchemaVersion(value.readMax) ||
      !isSchemaVersion(value.write) ||
      value.readMin > value.readMax ||
      value.write < value.readMin ||
      value.write > value.readMax
    ) {
      throw new Error(`Module data schema is invalid: ${expectedId}`)
    }
  }
}

function validateReleaseNote(note, version) {
  const bytes = Buffer.byteLength(note)
  if (bytes === 0 || bytes > 64 * 1024) {
    throw new Error('Release note has invalid byte size')
  }
  const blocks = note.split(/^\s*---\s*$/m)
  if (blocks.length !== 2 || blocks.some((block) => !block.trim())) {
    throw new Error('Release note must contain English and Chinese blocks')
  }
  for (const block of blocks) {
    const heading = block.match(/^##\s+(\d+(?:\.\d+){2,3})\b/m)
    if (heading?.[1] !== version) {
      throw new Error(`Release note headings must use version ${version}`)
    }
  }
}

function assertCoreVersion(value) {
  if (typeof value !== 'string' || !CORE_VERSION.test(value)) {
    throw new Error('Core version must contain three or four numeric segments')
  }
}

function assertModuleId(value) {
  if (typeof value !== 'string' || !MODULE_ID.test(value)) {
    throw new Error('Module id is invalid')
  }
}

function assertModuleVersion(value) {
  if (typeof value !== 'string' || !MODULE_VERSION.test(value)) {
    throw new Error('Module version must be stable X.Y.Z semver')
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || !value)
    throw new Error(`${label} is invalid`)
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value, expected) {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  )
}

function isSchemaVersion(value) {
  return Number.isSafeInteger(value) && value >= 0
}

async function readJson(root, relativePath) {
  return JSON.parse(await readText(root, relativePath))
}

async function readText(root, relativePath) {
  return readFile(path.resolve(root, relativePath), 'utf8')
}

async function writeJson(root, relativePath, value) {
  await writeFile(
    path.resolve(root, relativePath),
    `${JSON.stringify(value, null, 2)}\n`,
  )
}

async function main(args) {
  const [command, product, id, version, ...extra] = args
  if (extra.length > 0 || (command !== 'prepare' && command !== 'check')) {
    throw new Error(
      'Usage: release.mjs <prepare|check> <core VERSION|module ID VERSION>',
    )
  }
  const result =
    command === 'prepare'
      ? await prepareRelease(process.cwd(), product, id, version)
      : await checkRelease(process.cwd(), product, id, version)
  console.log(`${command === 'prepare' ? 'Prepared' : 'Checked'} ${result.tag}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
