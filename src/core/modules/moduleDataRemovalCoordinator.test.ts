import {
  ModuleDataRemovalCoordinator,
  type ModuleDataRemovalCoordinatorOptions,
  type ModuleDataRemovalJournal,
  type ModuleOwnedDataDescriptor,
} from './moduleDataRemovalCoordinator'

const TOKEN = Object.freeze({ authorization: 'high-risk' })
const CONTENT: ModuleOwnedDataDescriptor = {
  kind: 'learning-canonical-content',
  moduleId: 'learning',
  projectSlug: 'typescript',
  path: 'YOLO/learning/typescript',
  deletion: 'trash',
}
const SRS: ModuleOwnedDataDescriptor = {
  kind: 'learning-srs',
  moduleId: 'learning',
  projectSlug: 'typescript',
  path: 'YOLO/.yolo_json_db/learning-srs/typescript.json',
  deletion: 'exact',
}
const PRIVATE: ModuleOwnedDataDescriptor = {
  kind: 'module-private-namespace',
  moduleId: 'learning',
  locality: 'device-local',
  namespace: 'anki-runtime',
  deletion: 'exact',
}
const CONFIG: ModuleOwnedDataDescriptor = {
  kind: 'config-document',
  moduleId: 'learning',
  documentId: 'settings',
  path: 'YOLO/.yolo_json_db/module-settings/learning.json',
  deletion: 'exact',
}
const IMPORT_JOURNAL: ModuleOwnedDataDescriptor = {
  kind: 'learning-import-journal',
  moduleId: 'learning',
  journalId: '123e4567-e89b-42d3-a456-426614174000',
  path: 'YOLO/.yolo_json_db/anki-import-journals/123e4567-e89b-42d3-a456-426614174000.json',
  deletion: 'exact',
}

type FixtureOptions = Readonly<{
  active?: boolean
  desiredInstalled?: boolean
  authorized?: boolean
  approve?: (descriptor: ModuleOwnedDataDescriptor) => Promise<boolean>
  remove?: (descriptor: ModuleOwnedDataDescriptor) => Promise<void>
}>

function fixture(options: FixtureOptions = {}) {
  const events: string[] = []
  let journal: ModuleDataRemovalJournal | null = null
  const uninstall = jest.fn(async (_moduleId: string) => {
    events.push('artifact-uninstall')
  })
  const runWithModuleQuiesced: ModuleDataRemovalCoordinatorOptions['runtime']['runWithModuleQuiesced'] =
    async (_moduleId, operation) => {
      events.push('quiesce')
      if (options.active) throw new Error('module is active')
      return operation()
    }
  const get = jest.fn(async () => ({
    desiredInstalled: options.desiredInstalled ?? false,
    enabled: false,
  }))
  const approve = jest.fn(async (_moduleId, descriptor) => {
    events.push(`approve:${descriptor.kind}`)
    return options.approve ? options.approve(descriptor) : true
  })
  const verifyHighRiskToken = jest.fn(async (token) => {
    events.push('authorize')
    return (options.authorized ?? true) && token === TOKEN
  })
  const remove = jest.fn(async (descriptor: ModuleOwnedDataDescriptor) => {
    events.push(`remove:${descriptor.kind}:${descriptor.deletion}`)
    await options.remove?.(descriptor)
  })
  const readJournal = jest.fn(async () => journal)
  const writeJournal = jest.fn(async (_moduleId, value) => {
    journal = value
    events.push(`journal:${value.completedDescriptorIds.length}`)
  })
  const removeJournal = jest.fn(async () => {
    journal = null
    events.push('journal-remove')
  })
  const coordinator = new ModuleDataRemovalCoordinator({
    artifactUninstaller: { uninstall },
    runtime: { runWithModuleQuiesced },
    intentStore: { get },
    ownership: { approve },
    authorization: { verifyHighRiskToken },
    removal: { remove },
    journal: {
      read: readJournal,
      write: writeJournal,
      remove: removeJournal,
    },
  })
  return {
    coordinator,
    events,
    uninstall,
    get,
    approve,
    verifyHighRiskToken,
    remove,
    readJournal,
    writeJournal,
    removeJournal,
    getJournal: () => journal,
  }
}

describe('ModuleDataRemovalCoordinator', () => {
  it('keeps all data by default and is not part of ordinary uninstall', async () => {
    const value = fixture()

    await value.uninstall('learning')

    expect(value.remove).not.toHaveBeenCalled()
    expect(value.readJournal).not.toHaveBeenCalled()
    expect(value.verifyHighRiskToken).not.toHaveBeenCalled()
  })

  it('requires ordinary uninstall, quiescence, false intent, ownership, then authorization', async () => {
    const value = fixture()

    await value.coordinator.uninstallAndRemoveData(
      'learning',
      [CONFIG, SRS, PRIVATE, IMPORT_JOURNAL, CONTENT],
      TOKEN,
    )

    expect(value.events).toEqual([
      'artifact-uninstall',
      'quiesce',
      'approve:learning-canonical-content',
      'approve:learning-srs',
      'approve:learning-import-journal',
      'approve:config-document',
      'approve:module-private-namespace',
      'authorize',
      'journal:0',
      'remove:learning-canonical-content:trash',
      'journal:1',
      'remove:learning-srs:exact',
      'journal:2',
      'remove:learning-import-journal:exact',
      'journal:3',
      'remove:config-document:exact',
      'journal:4',
      'remove:module-private-namespace:exact',
      'journal:5',
      'journal-remove',
    ])
  })

  it('rejects missing or invalid authorization without any data mutation', async () => {
    const value = fixture({ authorized: false })

    await expect(
      value.coordinator.uninstallAndRemoveData('learning', [CONTENT], TOKEN),
    ).rejects.toThrow('high-risk authorization token')

    expect(value.uninstall).toHaveBeenCalledTimes(1)
    expect(value.approve).toHaveBeenCalledTimes(1)
    expect(value.remove).not.toHaveBeenCalled()
    expect(value.writeJournal).not.toHaveBeenCalled()
  })

  it('rejects active runtime and true install intent before authorization', async () => {
    const active = fixture({ active: true })
    await expect(
      active.coordinator.uninstallAndRemoveData('learning', [CONTENT], TOKEN),
    ).rejects.toThrow('active')
    expect(active.verifyHighRiskToken).not.toHaveBeenCalled()
    expect(active.remove).not.toHaveBeenCalled()

    const installed = fixture({ desiredInstalled: true })
    await expect(
      installed.coordinator.uninstallAndRemoveData(
        'learning',
        [CONTENT],
        TOKEN,
      ),
    ).rejects.toThrow('desiredInstalled to be false')
    expect(installed.verifyHighRiskToken).not.toHaveBeenCalled()
    expect(installed.remove).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'content traversal',
      descriptor: { ...CONTENT, path: 'YOLO/learning/../notes' },
    },
    {
      label: 'content exact deletion',
      descriptor: { ...CONTENT, deletion: 'exact' },
    },
    {
      label: 'SRS project alias',
      descriptor: {
        ...SRS,
        path: 'YOLO/.yolo_json_db/learning-srs/other.json',
      },
    },
    {
      label: 'arbitrary recursive namespace',
      descriptor: { ...PRIVATE, namespace: '../all' },
    },
    {
      label: 'config outside managed documents',
      descriptor: { ...CONFIG, path: 'YOLO/learning/index.md' },
    },
    {
      label: 'journal id and path mismatch',
      descriptor: {
        ...IMPORT_JOURNAL,
        path: 'YOLO/.yolo_json_db/anki-import-journals/223e4567-e89b-42d3-a456-426614174000.json',
      },
    },
    {
      label: 'foreign owner',
      descriptor: { ...CONTENT, moduleId: 'notes' },
    },
  ])('fails closed for $label', async ({ descriptor }) => {
    const value = fixture()
    await expect(
      value.coordinator.uninstallAndRemoveData(
        'learning',
        [descriptor as ModuleOwnedDataDescriptor],
        TOKEN,
      ),
    ).rejects.toThrow()
    expect(value.uninstall).not.toHaveBeenCalled()
    expect(value.remove).not.toHaveBeenCalled()
  })

  it('rejects canonical path aliases before ordinary uninstall', async () => {
    const value = fixture()

    await expect(
      value.coordinator.uninstallAndRemoveData(
        'learning',
        [CONTENT, { ...CONTENT, path: 'yolo/learning/typescript' }],
        TOKEN,
      ),
    ).rejects.toThrow('unique')
    expect(value.uninstall).not.toHaveBeenCalled()
    expect(value.remove).not.toHaveBeenCalled()
  })

  it('requires Host ownership approval even for a syntactically valid path', async () => {
    const value = fixture({ approve: async () => false })

    await expect(
      value.coordinator.uninstallAndRemoveData('learning', [CONTENT], TOKEN),
    ).rejects.toThrow('Host ownership policy')
    expect(value.verifyHighRiskToken).not.toHaveBeenCalled()
    expect(value.remove).not.toHaveBeenCalled()
  })

  it('preserves existing case-sensitive Learning project slug identities', async () => {
    const value = fixture()
    const content: ModuleOwnedDataDescriptor = {
      ...CONTENT,
      projectSlug: 'React-3',
      path: 'YOLO/learning/React-3',
    }
    const srs: ModuleOwnedDataDescriptor = {
      ...SRS,
      projectSlug: 'React-3',
      path: 'YOLO/.yolo_json_db/learning-srs/React-3.json',
    }

    await expect(
      value.coordinator.uninstallAndRemoveData(
        'learning',
        [content, srs],
        TOKEN,
      ),
    ).resolves.toBeDefined()
  })

  it('journals completed operations and resumes a partial failure idempotently', async () => {
    let failed = false
    const value = fixture({
      remove: async (descriptor) => {
        if (descriptor.kind === 'learning-srs' && !failed) {
          failed = true
          throw new Error('SRS removal failed')
        }
      },
    })

    await expect(
      value.coordinator.uninstallAndRemoveData(
        'learning',
        [SRS, CONTENT],
        TOKEN,
      ),
    ).rejects.toThrow('SRS removal failed')
    expect(value.getJournal()?.completedDescriptorIds).toHaveLength(1)

    await expect(
      value.coordinator.uninstallAndRemoveData(
        'learning',
        [CONTENT, SRS],
        TOKEN,
      ),
    ).resolves.toMatchObject({
      removedDescriptorIds: [expect.stringContaining('learning-srs:')],
      resumedDescriptorIds: [expect.stringContaining('learning-content:')],
    })
    expect(
      value.remove.mock.calls.filter(
        ([descriptor]) => descriptor.kind === 'learning-canonical-content',
      ),
    ).toHaveLength(1)
    expect(value.getJournal()).toBeNull()
    expect(value.uninstall).toHaveBeenCalledTimes(2)
    expect(value.verifyHighRiskToken).toHaveBeenCalledTimes(2)
  })
})
