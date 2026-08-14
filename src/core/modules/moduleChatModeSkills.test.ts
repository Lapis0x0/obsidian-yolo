import { createModuleChatModeSkillResolver } from './moduleChatModeSkills'
import type { ModuleArtifactManifest } from './moduleStore'

function buildArtifact(
  overrides: Partial<{
    moduleId: string
    version: string
    files: ModuleArtifactManifest['variants'][number]['files']
  }> = {},
) {
  const moduleId = overrides.moduleId ?? 'learning'
  const version = overrides.version ?? '1.0.0'
  const files = overrides.files ?? [
    Object.freeze({
      role: 'entry' as const,
      name: 'entry.js',
      path: 'entry.js',
      byteSize: 1,
      sha256: 'a'.repeat(64),
      url: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-${moduleId}-v${version}/entry.js`,
      storage: 'module' as const,
    }),
    Object.freeze({
      role: 'data' as const,
      name: 'outline-skill.md',
      path: 'outline-skill.md',
      byteSize: 10,
      sha256: 'b'.repeat(64),
      url: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-${moduleId}-v${version}/outline-skill.md`,
      storage: 'module' as const,
    }),
  ]
  const manifest: ModuleArtifactManifest = Object.freeze({
    schemaVersion: 1,
    id: moduleId,
    version,
    hostApi: '^1.0.0',
    dataSchemas: Object.freeze({}),
    variants: Object.freeze([
      Object.freeze({
        platform: 'desktop' as const,
        entry: 'entry.js',
        files: Object.freeze(files),
      }),
    ]),
  })
  return Object.freeze({
    manifest,
    variant: manifest.variants[0],
    entryBytes: new Uint8Array(),
  })
}

describe('createModuleChatModeSkillResolver', () => {
  it('resolves a declared role:data file name to the trusted ModuleStore path', async () => {
    const artifact = buildArtifact()
    const resolveEntryPath = jest.fn(
      (moduleId: string, version: string, entryPath: string) =>
        `/plugins/yolo/modules/${moduleId}/${version}/${entryPath}`,
    )
    const resolver = createModuleChatModeSkillResolver({
      store: { resolveEntryPath },
      getVerifiedArtifact: () => artifact,
    })

    const path = await resolver.resolveSkillPath('learning', 'outline-skill.md')

    expect(path).toBe('/plugins/yolo/modules/learning/1.0.0/outline-skill.md')
    expect(resolveEntryPath).toHaveBeenCalledWith(
      'learning',
      '1.0.0',
      'outline-skill.md',
    )
  })

  it('returns null when the module has no verified artifact', async () => {
    const resolver = createModuleChatModeSkillResolver({
      store: { resolveEntryPath: jest.fn() },
      getVerifiedArtifact: () => undefined,
    })

    expect(await resolver.resolveSkillPath('learning', 'outline.md')).toBeNull()
  })

  it('returns null when the artifact identity does not match the requested module', async () => {
    const artifact = buildArtifact({ moduleId: 'learning' })
    const resolver = createModuleChatModeSkillResolver({
      store: { resolveEntryPath: jest.fn() },
      getVerifiedArtifact: () => artifact,
    })

    expect(
      await resolver.resolveSkillPath('other-module', 'outline-skill.md'),
    ).toBeNull()
  })

  it('returns null when no role:data file matches the requested name', async () => {
    const artifact = buildArtifact()
    const resolver = createModuleChatModeSkillResolver({
      store: { resolveEntryPath: jest.fn() },
      getVerifiedArtifact: () => artifact,
    })

    expect(
      await resolver.resolveSkillPath('learning', 'missing-skill.md'),
    ).toBeNull()
  })

  it('does not match a declared file with the same name but a non-data role', async () => {
    const artifact = buildArtifact({
      files: [
        Object.freeze({
          role: 'style' as const,
          name: 'outline-skill.md',
          path: 'outline-skill.md',
          byteSize: 10,
          sha256: 'b'.repeat(64),
          url: 'https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v1.0.0/outline-skill.md',
          storage: 'module' as const,
        }),
      ],
    })
    const resolver = createModuleChatModeSkillResolver({
      store: { resolveEntryPath: jest.fn() },
      getVerifiedArtifact: () => artifact,
    })

    expect(
      await resolver.resolveSkillPath('learning', 'outline-skill.md'),
    ).toBeNull()
  })

  it('returns null for an unsafe file name instead of throwing', async () => {
    const artifact = buildArtifact()
    const resolver = createModuleChatModeSkillResolver({
      store: { resolveEntryPath: jest.fn() },
      getVerifiedArtifact: () => artifact,
    })

    expect(
      await resolver.resolveSkillPath('learning', '../escape.md'),
    ).toBeNull()
  })

  it('resolves the artifact getter lazily (supports an async accessor)', async () => {
    const artifact = buildArtifact()
    const resolver = createModuleChatModeSkillResolver({
      store: {
        resolveEntryPath: (moduleId, version, entryPath) =>
          `${moduleId}/${version}/${entryPath}`,
      },
      getVerifiedArtifact: async () => artifact,
    })

    expect(
      await resolver.resolveSkillPath('learning', 'outline-skill.md'),
    ).toBe('learning/1.0.0/outline-skill.md')
  })
})
