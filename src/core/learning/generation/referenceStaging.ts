import { App, normalizePath } from 'obsidian'

export type StagedReference = {
  name: string
  vaultPath: string
}

const MAX_FILE_SIZE = 20 * 1024 * 1024
const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.doc', '.md', '.markdown', '.txt']

export function validateReferenceFile(file: File): string | null {
  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? ''
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return `不支持的文件类型：${ext}（支持 PDF、Word、Markdown、文本）`
  }
  if (file.size > MAX_FILE_SIZE) {
    return `文件过大：${(file.size / 1024 / 1024).toFixed(1)}MB（上限 20MB）`
  }
  return null
}

export async function createStagingDir(
  app: App,
  learningBaseDir: string,
  tempId: string,
): Promise<string> {
  const stagingPath = normalizePath(`${learningBaseDir}/.staging/${tempId}`)
  await ensureFolder(app, stagingPath)
  return stagingPath
}

export async function writeReferenceToStaging(
  app: App,
  stagingDir: string,
  fileName: string,
  content: ArrayBuffer,
): Promise<StagedReference> {
  const vaultPath = normalizePath(`${stagingDir}/${fileName}`)
  await app.vault.adapter.writeBinary(vaultPath, content)
  return { name: fileName, vaultPath }
}

export async function moveStagingToProject(
  app: App,
  stagingDir: string,
  projectPath: string,
): Promise<string> {
  const refPath = normalizePath(`${projectPath}/ref`)
  await ensureFolder(app, refPath)

  const listed = await app.vault.adapter.list(stagingDir)
  for (const filePath of listed.files) {
    const fileName = filePath.split('/').at(-1)
    if (!fileName) continue
    const destPath = normalizePath(`${refPath}/${fileName}`)
    await app.vault.adapter.rename(filePath, destPath)
  }

  await app.vault.adapter.rmdir(stagingDir, true)

  return refPath
}

export async function cleanupStaging(
  app: App,
  stagingDir: string,
): Promise<void> {
  try {
    await app.vault.adapter.rmdir(stagingDir, true)
  } catch {
    return
  }
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  if (app.vault.getAbstractFileByPath(folderPath)) return
  await app.vault.adapter.mkdir(folderPath)
}
