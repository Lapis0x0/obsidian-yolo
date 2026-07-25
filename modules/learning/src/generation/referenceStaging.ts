import { normalizeLearningVaultPath } from '../domain/learningVaultReadApi'
import type { LearningVaultWriteApi } from '../domain/learningVaultWriteApi'
import type { LearningTranslation } from '../i18n'

export type StagedReference = { name: string; vaultPath: string }

const MAX_FILE_SIZE = 20 * 1024 * 1024
const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.doc', '.md', '.markdown', '.txt']

export function validateReferenceFile(
  file: File,
  t: LearningTranslation,
): string | null {
  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? ''
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return t('generation.unsupportedFileType').replace('{ext}', ext)
  }
  if (file.size > MAX_FILE_SIZE) {
    const size = (file.size / 1024 / 1024).toFixed(1)
    return t('generation.fileTooLarge').replace('{size}', size)
  }
  return null
}

export async function createStagingDir(
  writer: LearningVaultWriteApi,
  learningBaseDir: string,
  tempId: string,
): Promise<string> {
  const stagingPath = joinVaultPath(learningBaseDir, '_staging', tempId)
  await writer.ensureFolder(stagingPath)
  return stagingPath
}

export async function writeReferenceToStaging(
  writer: LearningVaultWriteApi,
  stagingDir: string,
  fileName: string,
  content: ArrayBuffer,
): Promise<StagedReference> {
  const vaultPath = joinVaultPath(stagingDir, fileName)
  await writer.createBinary(vaultPath, content)
  return { name: fileName, vaultPath }
}

export async function moveStagingToProject(
  writer: LearningVaultWriteApi,
  stagingDir: string,
  projectPath: string,
): Promise<string> {
  const refPath = joinVaultPath(projectPath, 'ref')
  await writer.ensureFolder(refPath)
  for (const filePath of await writer.listChildFilePaths(stagingDir)) {
    const fileName = filePath.split('/').at(-1)
    if (fileName)
      await writer.renamePath(filePath, joinVaultPath(refPath, fileName))
  }
  await writer.removeTree(stagingDir)
  return refPath
}

export async function cleanupStaging(
  writer: LearningVaultWriteApi,
  stagingDir: string,
): Promise<void> {
  try {
    await writer.removeTree(stagingDir)
  } catch {
    return
  }
}

const joinVaultPath = (...parts: string[]) =>
  normalizeLearningVaultPath(parts.join('/'))
