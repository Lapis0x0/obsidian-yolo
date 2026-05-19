import { App, normalizePath } from 'obsidian'

import type { FileEntry } from './skillValidation'

export type SkillWritePackage = {
  sourceName: string
  targetName: string
  files: FileEntry[]
  isDirectory: boolean
}

function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath) return false
  if (relativePath.startsWith('/') || relativePath.startsWith('\\'))
    return false
  if (/(^|\/)\.\.(\/|$)/.test(relativePath)) return false
  if (/\\/.test(relativePath)) return false
  if (/^[a-zA-Z]:/.test(relativePath)) return false
  return true
}

export async function writeSkillPackages(
  app: App,
  skillsDir: string,
  packages: SkillWritePackage[],
): Promise<{ successCount: number; errors: string[] }> {
  let successCount = 0
  const errors: string[] = []

  const ensureFolder = async (path: string) => {
    const segments = path.split('/').filter((s) => s.length > 0)
    let cur = ''
    for (const seg of segments) {
      cur = cur ? `${cur}/${seg}` : seg
      if (!app.vault.getAbstractFileByPath(cur)) {
        await app.vault.createFolder(cur)
      }
    }
  }

  await ensureFolder(skillsDir)

  for (const pkg of packages) {
    try {
      if (pkg.isDirectory) {
        const pkgDir = normalizePath(`${skillsDir}/${pkg.targetName}`)
        const existing = app.vault.getAbstractFileByPath(pkgDir)
        if (existing) {
          await app.fileManager.trashFile(existing)
        }
        await app.vault.createFolder(pkgDir)

        for (const file of pkg.files) {
          if (!isSafeRelativePath(file.relativePath)) {
            throw new Error(`unsafe path: ${file.relativePath}`)
          }
          const targetPath = normalizePath(`${pkgDir}/${file.relativePath}`)
          if (!targetPath.startsWith(`${pkgDir}/`)) {
            throw new Error(`path escaped target: ${file.relativePath}`)
          }
          const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/'))
          if (parentDir) {
            await ensureFolder(parentDir)
          }
          await app.vault.create(targetPath, file.content)
        }
      } else {
        const targetPath = normalizePath(`${skillsDir}/${pkg.targetName}`)
        if (!targetPath.startsWith(`${skillsDir}/`)) {
          throw new Error(`path escaped target: ${pkg.targetName}`)
        }
        const existing = app.vault.getAbstractFileByPath(targetPath)
        if (existing) {
          await app.fileManager.trashFile(existing)
        }
        await app.vault.create(targetPath, pkg.files[0].content)
      }
      successCount++
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      errors.push(`${pkg.sourceName}: ${message}`)
    }
  }

  return { successCount, errors }
}
