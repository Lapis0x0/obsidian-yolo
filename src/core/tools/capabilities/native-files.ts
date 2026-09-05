import { defineCapability } from '../define'
import { editFileDefinition } from '../edit_file/definition'
import { readFileDefinition } from '../read_file/definition'
import { writeFileDefinition } from '../write_file/definition'

/**
 * Direct local-filesystem access, desktop-only (docs/plans/09-05-yolo-max/
 * master.md §1 and decisions Q3/Q5, p1-design.md §3).
 *
 * These are a *separate identity* from the vault-backed `file_reading` /
 * `file_editing` capabilities rather than an extra mode of them: the vault
 * tools' whole contract — vault-relative paths, wikilink resolution, the
 * editor buffer staying consistent — is what makes them safe for the Agent
 * mode community relies on, and nothing here shares it. Keeping the two
 * apart is also what lets a mode grant one without the other.
 *
 * `category: 'external'` for the same reason `terminal` is external: the
 * reach is the user's machine, not the vault. `defaultEnabled: true` with
 * `approval.defaultMode: 'full_access'` is the Max standard trust tier
 * (Q8) — it costs nothing while no mode exposes these tools, and the
 * boundary that actually matters (a write outside the vault) is enforced by
 * the gateway, not by an all-or-nothing settings toggle.
 */
export const nativeFilesCapability = defineCapability({
  id: 'native_files',
  label: {
    key: 'settings.agent.builtinNativeFilesLabel',
    fallback: 'Local Filesystem Toolset',
  },
  description: {
    key: 'settings.agent.builtinNativeFilesDesc',
    fallback:
      'Read, write, and edit files directly on the local filesystem, at any path and any extension. Desktop-only, and only available in Max mode.',
  },
  category: 'external',
  defaultEnabled: true,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: false,
  tools: [readFileDefinition, writeFileDefinition, editFileDefinition],
})
