import { defineCapability } from '../define'
import { vaultSearchDefinition } from '../vault_search/definition'

/**
 * Semantic vault retrieval as a first-class capability
 * (docs/plans/09-10-vault-search/plan.md).
 *
 * It used to exist only as attachments to other capabilities — the virtual
 * shell's custom `search` subcommand and `js_eval`'s `$db.search` — which
 * left Max, where both of those are withheld, with no semantic retrieval at
 * all. It is also the wrong shape: reaching the vault's vector index is not
 * a shell builtin, and a model had to know about `bash` first to find it.
 *
 * `chatModes` covers all three built-in modes. Ask's promise is "do not
 * change my vault", not "do not read it", and this capability cannot write.
 * No `isAvailable`: `runVaultSearchStructured` degrades to keyword ranking
 * when no embedding model or knowledge base is configured, so the tool is
 * useful in every vault — the degradation comes back as `fallbackReason` on
 * the result rather than as a missing tool.
 *
 * Approval matches `file_reading`: reading the vault is the same act here,
 * whichever index answers it.
 */
export const vaultSearchCapability = defineCapability({
  id: 'vault_search',
  label: {
    key: 'settings.agent.builtinVaultSearchLabel',
    fallback: 'Vault Search',
  },
  description: {
    key: 'settings.agent.builtinVaultSearchDesc',
    fallback:
      'Search the vault by meaning, combining knowledge-base vector retrieval with keyword matching.',
  },
  category: 'vault',
  chatModes: ['ask', 'agent', 'max'],
  defaultEnabled: true,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: false,
  tools: [vaultSearchDefinition],
})
