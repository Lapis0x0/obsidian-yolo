import { LearningCardFileStore, scanProjectCards } from '../../domain/cardFile'
import {
  createHostLearningVaultReadApi,
  createHostLearningVaultWriteApi,
} from '../../domain/hostVaultAdapter'
import type { LearningVaultWriteApi } from '../../domain/learningVaultWriteApi'
import { ProjectEventBus } from '../../domain/projectEventBus'
import { scanProject, scanProjects } from '../../domain/projectScanner'
import type { LearningGenerationHost } from '../../generation/host'
import { createLearningGenerationAgent } from '../../generation/moduleAgentAdapter'
import { generateOutline } from '../../generation/outlineGenerator'
import {
  validateReferenceFile,
  writeReferenceToStaging,
} from '../../generation/referenceStaging'
import type { CardsViewServices } from '../../ui/cards/CardsView'
import type { ExercisesViewServices } from '../../ui/exercises/ExercisesView'
import type { HomeProjectActions } from '../../ui/home/HomeView'
import type { OutlineBuilderWorkflow } from '../../ui/outline/OutlineBuilder'
import type { OutlineViewHost } from '../../ui/outline/OutlineView'
import type { WizardReferenceHost } from '../../ui/wizard/Wizard'
import {
  type HostLearningRuntimeAdapter,
  createHostLearningTranslation,
} from '../runtime'
import {
  assertCurrentProjectPath,
  assertPathInRoot,
  normalizePath,
} from '../vaultPaths'

type Runtime = HostLearningRuntimeAdapter['runtime']

export type CreateLearningUiServicesOptions = Readonly<{
  runtime: Runtime
  ownerDocument: Document
  /** Learning-specific generation model override, if the user configured one. */
  getGenerationModelId?: () => string | undefined
  reportError?: (message: string, error: unknown) => void
}>

export type LearningUiServices = Readonly<{
  ownerDocument: Document
  homeProjectActions: HomeProjectActions
  wizardReferences: WizardReferenceHost
  createOutlineBuilderWorkflow(): OutlineBuilderWorkflow
  /** Compatibility workflow for callers that construct it eagerly. */
  outlineBuilderWorkflow: OutlineBuilderWorkflow
  outlineViewHost: OutlineViewHost
  cardsViewServices: CardsViewServices
  exercisesViewServices: ExercisesViewServices
  eventBus: ProjectEventBus
  scanProjects(): ReturnType<typeof scanProjects>
  scanProject(projectPath: string): ReturnType<typeof scanProject>
  getLearningBaseDir(): string
  dispose(): void
}>

let stagingSequence = 0

/**
 * Closes the migrated Learning UI over Host 1.1 and the module runtime.
 * Every managed-root lookup is live so host path changes do not stale closures.
 *
 * Project generation (knowledge points + cards) is not owned here: it lives
 * in the module-level `ProjectGenerationService` (see `host/generation.ts`),
 * which is created once per module activation and outlives every mount and
 * every wizard. This factory only wires the mount-scoped UI adapters:
 * home actions, wizard staging, the outline draft workflow, and the project
 * event bus used to render the knowledge graph.
 */
export function createLearningUiServices(
  host: YoloModuleHostApiV1,
  options: CreateLearningUiServicesOptions,
): LearningUiServices {
  const t = createHostLearningTranslation(host)
  const vault = createHostLearningVaultReadApi(host.vault)
  const hostWriter = createHostLearningVaultWriteApi(host.vault)
  const cardFiles = new LearningCardFileStore(vault, hostWriter)
  const eventBus = new ProjectEventBus(vault)
  const getLearningBaseDir = () =>
    normalizePath(host.paths.getSnapshot().contentRoot)
  const generationHost: LearningGenerationHost = {
    vault,
    // The generation code only consumes the CAS subset. Host 1.1 deliberately
    // does not implement LearningVaultWriteApi's permanent-removal operations.
    vaultWriter: hostWriter as LearningVaultWriteApi,
    agent: createLearningGenerationAgent(host.agent),
  }

  const markdown = {
    createRenderer: () => host.ui.createMarkdownRenderer(),
  }
  const getSrs = () => options.runtime.getSrsStore()

  const homeProjectActions: HomeProjectActions = {
    setPaused: async (project, paused) => {
      if (paused) await getSrs().pauseProject(project.slug, new Date())
      else await getSrs().resumeProject(project.slug, new Date())
    },
    deleteProject: async (project) => {
      assertCurrentProjectPath(project.folderPath, getLearningBaseDir())
      const entry = host.vault.getEntry(project.folderPath)
      if (entry?.kind !== 'folder') {
        throw new Error(
          `Learning project folder not found: ${project.folderPath}`,
        )
      }
      const srs = getSrs()
      const wasPaused = await srs.isProjectPaused(project.slug)
      if (!wasPaused) await srs.pauseProject(project.slug, new Date())
      try {
        const trashed = await host.vault.trashPath(entry.path)
        if (!trashed) {
          throw new Error(`Learning project folder not found: ${entry.path}`)
        }
      } catch (error) {
        if (!wasPaused) {
          try {
            await srs.resumeProject(project.slug, new Date())
          } catch (resumeError) {
            options.reportError?.(
              'Failed to restore Learning project pause state',
              resumeError,
            )
          }
        }
        throw error
      }
      try {
        await srs.deleteProjectState(project.slug)
        return 'deleted'
      } catch (error) {
        options.reportError?.('Failed to delete Learning SRS state', error)
        return 'deleted-state-failed'
      }
    },
    confirmDelete: (project, onConfirm) => {
      void host.ui
        .confirm({
          title: t('home.deleteConfirmTitle'),
          message: t('home.deleteConfirmMessage').replace(
            '{project}',
            project.topic,
          ),
          ctaText: t('common.delete'),
          cancelText: t('common.cancel'),
        })
        .then((confirmed) => {
          if (confirmed) onConfirm()
        })
        .catch((error: unknown) => {
          options.reportError?.(
            'Failed to confirm Learning project deletion',
            error,
          )
        })
    },
    showNotice: (message) => host.ui.notice(message),
    reportError: options.reportError,
  }

  const wizardReferences: WizardReferenceHost = {
    createStagingDir: async () => {
      const root = getLearningBaseDir()
      const path = `${root}/_staging/${Date.now().toString(36)}-${(stagingSequence++).toString(
        36,
      )}`
      await host.vault.ensureFolder(path)
      return path
    },
    validateFile: (file) => validateReferenceFile(file, t),
    writeFile: async (stagingDir, file) => {
      assertPathInRoot(stagingDir, getLearningBaseDir(), '_staging')
      return writeReferenceToStaging(
        hostWriter as LearningVaultWriteApi,
        stagingDir,
        file.name,
        file.contents,
      )
    },
    removeFile: async (path) => {
      assertPathInRoot(path, getLearningBaseDir(), '_staging')
      if (!(await host.vault.removeFileExact(path))) {
        throw new Error(`Staged reference not found: ${path}`)
      }
    },
    cleanup: async (stagingDir) => {
      assertPathInRoot(stagingDir, getLearningBaseDir(), '_staging')
      // The staging directory is a plugin-owned temporary folder, so remove it
      // with the folder-aware exact-removal APIs instead of routing a directory
      // through trashFile. When the vault is configured to delete permanently
      // (no trashOption / no .trash folder), trashing a *folder* fails with
      // EISDIR and leaves the staging directory behind, which then surfaces as
      // a generation failure. This mirrors moveStagedReferences, which already
      // removes the emptied staging folder via removeEmptyFolderExact.
      for (const entry of host.vault.listChildren(stagingDir)) {
        if (entry.kind === 'file') await host.vault.removeFileExact(entry.path)
      }
      await host.vault.removeEmptyFolderExact(stagingDir)
    },
  }

  const outlineViewHost: OutlineViewHost = {
    readText: async (path) =>
      host.vault.getEntry(path)?.kind === 'file'
        ? host.vault.readText(path)
        : null,
    openMarkdownAtLine: (path, line) => {
      void host.ui
        .openFileAt({ path, ...(line == null ? {} : { line }) })
        .catch((error: unknown) => {
          options.reportError?.('Failed to open Learning markdown', error)
        })
    },
    createMarkdownRenderer: () => host.ui.createMarkdownRenderer(),
    htmlToMarkdown: (html) => host.ui.htmlToMarkdown(html),
    openLinkText: (linktext, sourcePath, newLeaf) =>
      host.ui.openLink(linktext, sourcePath, newLeaf),
    isModEvent: (event) => host.ui.isModEvent(event),
    triggerHoverLink: ({ event, targetEl, linktext, sourcePath }) => {
      const HTMLElementConstructor =
        options.ownerDocument.defaultView?.HTMLElement
      if (
        !HTMLElementConstructor ||
        !(targetEl instanceof HTMLElementConstructor)
      ) {
        return
      }
      host.ui.hoverLink({ event, targetEl, linktext, sourcePath })
    },
  }

  const cardsViewServices: CardsViewServices = {
    vault,
    scanProjectCards: (projectPath, expectedCardPaths) =>
      scanProjectCards(vault, projectPath, expectedCardPaths),
    srs: getSrs(),
    cardFiles,
    markdown,
    showNotice: (message) => host.ui.notice(message),
  }

  const createWorkflow = (): OutlineBuilderWorkflow =>
    buildOutlineBuilderWorkflow({
      host,
      generationHost,
      getLearningBaseDir,
      getModelId: () =>
        options.getGenerationModelId?.() ??
        host.settings.getModelSnapshot().defaultModelId,
    })
  const outlineBuilderWorkflow = createWorkflow()

  let disposed = false
  return Object.freeze({
    ownerDocument: options.ownerDocument,
    homeProjectActions,
    wizardReferences,
    createOutlineBuilderWorkflow: createWorkflow,
    outlineBuilderWorkflow,
    outlineViewHost,
    cardsViewServices,
    exercisesViewServices: { vault } satisfies ExercisesViewServices,
    eventBus,
    scanProjects: () => scanProjects(vault, getLearningBaseDir()),
    scanProject: (projectPath) => {
      assertCurrentProjectPath(projectPath, getLearningBaseDir())
      return scanProject(vault, projectPath)
    },
    getLearningBaseDir,
    dispose: () => {
      if (disposed) return
      disposed = true
      eventBus.dispose()
    },
  })
}

function buildOutlineBuilderWorkflow({
  host,
  generationHost,
  getLearningBaseDir,
  getModelId,
}: {
  host: YoloModuleHostApiV1
  generationHost: LearningGenerationHost
  getLearningBaseDir: () => string
  getModelId: () => string | undefined
}): OutlineBuilderWorkflow {
  const t = createHostLearningTranslation(host)

  return {
    generateOutline: async (input) => {
      const root = getLearningBaseDir()
      for (const reference of input.referenceFiles ?? []) {
        assertPathInRoot(reference.vaultPath, root, '_staging')
      }
      const workspaceScope = input.stagingDir
        ? scopedReferenceWorkspace(input.stagingDir, root)
        : undefined
      const result = await generateOutline({
        host: generationHost,
        modelId: getModelId(),
        topic: input.topic,
        level: input.level,
        goal: input.goal,
        referencesBlock: input.referencesBlock,
        referenceFiles: input.referenceFiles?.map(({ name, vaultPath }) => ({
          name,
          vaultPath,
        })),
        workspaceScope,
        abortSignal: input.signal,
        activity: {
          title: t('generation.outlineActivity'),
          detail: input.topic,
        },
        onOutline: input.onOutline,
        onProgress: () => input.onProgress(),
      })
      return result.outline
    },
  }
}

function scopedReferenceWorkspace(stagingDir: string, root: string) {
  assertPathInRoot(stagingDir, root, '_staging')
  return { enabled: true, include: [stagingDir], exclude: [] }
}
