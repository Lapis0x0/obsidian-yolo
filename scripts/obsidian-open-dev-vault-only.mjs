// Marks only the dev vault (the vault this plugin checkout lives in) as open in
// Obsidian's vault registry, so the next launch restores just that vault instead
// of whatever vaults were open at the last quit. Must run while Obsidian is not
// running: Obsidian reads the registry on startup and rewrites it on quit.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const registryPath = path.join(
  os.homedir(),
  'Library/Application Support/obsidian/obsidian.json',
)
const devVaultPath = path.resolve(import.meta.dirname, '../../../..')

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
const vaults = Object.values(registry.vaults ?? {})
if (!vaults.some((vault) => vault.path === devVaultPath)) {
  console.error(`Dev vault ${devVaultPath} is not registered in Obsidian.`)
  process.exit(1)
}

for (const vault of vaults) {
  if (vault.path === devVaultPath) vault.open = true
  else delete vault.open
}
fs.writeFileSync(registryPath, JSON.stringify(registry))
