import { App, Notice, normalizePath } from 'obsidian'
import { useCallback, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import { getYoloSkillsDir } from '../../../core/paths/yoloPaths'
import { formatValidationErrors } from '../../../core/skills/importSkillValidationHelper'
import {
  type FileEntry,
  parseFrontmatter,
  validateDirectoryPackage,
  validateSingleFileSkill,
} from '../../../core/skills/skillValidation'
import { writeSkillPackages } from '../../../core/skills/skillWriter'
import YoloPlugin from '../../../main'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ReactModal } from '../../common/ReactModal'
import { ConfirmModal } from '../../modals/ConfirmModal'

type ImportSkillModalProps = {
  app: App
  plugin: YoloPlugin
  onImported?: () => void
}

export class ImportSkillModal extends ReactModal<ImportSkillModalProps> {
  constructor(app: App, plugin: YoloPlugin, onImported?: () => void) {
    super({
      app,
      Component: ImportSkillModalWrapper,
      props: { app, plugin, onImported },
      options: {
        title: plugin.t('settings.agent.importSkill', 'Import Skill'),
      },
      plugin,
    })
  }
}

function ImportSkillModalWrapper({
  app,
  plugin,
  onImported,
  onClose,
}: ImportSkillModalProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <ImportSkillModalContent
        app={app}
        onImported={onImported}
        onClose={onClose}
      />
    </SettingsProvider>
  )
}

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 一个准备导入的 skill 包(已经识别出根目录 / 单文件)。
 */
type SkillPackage = {
  /** 用作错误信息显示的源名称(原文件夹名 / 文件名) */
  sourceName: string
  /** 目标名称:目录模式 = frontmatter.name;单文件模式 = 源文件名 */
  targetName: string
  /** 用于列表显示 */
  displayName: string
  description: string
  files: FileEntry[]
  isDirectory: boolean
}

const SKILL_MD = 'SKILL.md'
const MAX_PATH_DEPTH = 16

// ---------------------------------------------------------------------------
// 文件系统读取(同步收集 entries,再异步读取)
// ---------------------------------------------------------------------------

type RawCandidate = {
  rootName: string
  files: FileEntry[]
  isSingleFile: boolean
}

async function readDirectoryEntryRecursively(
  dirEntry: FileSystemDirectoryEntry,
  basePath: string,
  depth: number,
): Promise<FileEntry[]> {
  if (depth > MAX_PATH_DEPTH) return []

  const readBatch = (
    reader: FileSystemDirectoryReader,
  ): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })

  const reader = dirEntry.createReader()
  const entries: FileSystemEntry[] = []
  let batch = await readBatch(reader)
  while (batch.length > 0) {
    entries.push(...batch)
    batch = await readBatch(reader)
  }

  const results: FileEntry[] = []
  for (const entry of entries) {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry
      const file = await new Promise<File>((resolve, reject) => {
        fileEntry.file(resolve, reject)
      })
      const content = await file.text()
      const relativePath = basePath
        ? `${basePath}/${fileEntry.name}`
        : fileEntry.name
      results.push({ relativePath, content })
    } else if (entry.isDirectory) {
      const subDir = entry as FileSystemDirectoryEntry
      const subPath = basePath ? `${basePath}/${subDir.name}` : subDir.name
      const subFiles = await readDirectoryEntryRecursively(
        subDir,
        subPath,
        depth + 1,
      )
      results.push(...subFiles)
    }
  }
  return results
}

/**
 * 从 DataTransferItemList 解析 raw candidates。
 * 必须先同步收集所有 entry,因为 await 之后 webkitGetAsEntry 可能返回 null。
 */
async function readRawCandidatesFromDataTransfer(
  items: DataTransferItemList,
): Promise<RawCandidate[]> {
  // Step 1: 同步收集所有 entry
  const rootEntries: FileSystemEntry[] = []
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.()
    if (entry) rootEntries.push(entry)
  }

  // Step 2: 异步读取
  const candidates: RawCandidate[] = []
  for (const entry of rootEntries) {
    if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry
      const files = await readDirectoryEntryRecursively(dirEntry, '', 0)
      candidates.push({
        rootName: dirEntry.name,
        files,
        isSingleFile: false,
      })
    } else if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry
      if (!isMarkdownFileName(fileEntry.name)) continue
      const file = await new Promise<File>((resolve, reject) => {
        fileEntry.file(resolve, reject)
      })
      const content = await file.text()
      candidates.push({
        rootName: fileEntry.name,
        files: [{ relativePath: fileEntry.name, content }],
        isSingleFile: true,
      })
    }
  }
  return candidates
}

async function readRawCandidatesFromFileList(
  files: FileList,
): Promise<RawCandidate[]> {
  const fileArray = Array.from(files)
  if (fileArray.length === 0) return []

  const firstRelPath = (fileArray[0] as { webkitRelativePath?: string })
    .webkitRelativePath
  const isFolderMode = !!firstRelPath && firstRelPath.includes('/')

  if (!isFolderMode) {
    const candidates: RawCandidate[] = []
    for (const file of fileArray) {
      if (!isMarkdownFileName(file.name)) continue
      const content = await file.text()
      candidates.push({
        rootName: file.name,
        files: [{ relativePath: file.name, content }],
        isSingleFile: true,
      })
    }
    return candidates
  }

  // 文件夹选择:浏览器一次性返回所有文件,根据 webkitRelativePath 的首段分组成一个 root
  const groupedByRoot = new Map<string, FileEntry[]>()
  for (const file of fileArray) {
    const relPath =
      (file as { webkitRelativePath?: string }).webkitRelativePath ?? ''
    if (!relPath) continue
    const slashIdx = relPath.indexOf('/')
    const rootDir = slashIdx > 0 ? relPath.slice(0, slashIdx) : relPath
    const innerPath = slashIdx > 0 ? relPath.slice(slashIdx + 1) : ''
    if (!innerPath) continue
    const content = await file.text()
    const entries = groupedByRoot.get(rootDir) ?? []
    entries.push({ relativePath: innerPath, content })
    groupedByRoot.set(rootDir, entries)
  }

  return [...groupedByRoot.entries()].map(([rootName, files]) => ({
    rootName,
    files,
    isSingleFile: false,
  }))
}

function isMarkdownFileName(name: string): boolean {
  return name.endsWith('.md') || name.endsWith('.markdown')
}

// ---------------------------------------------------------------------------
// 父目录展开:从 raw candidate 中提取一到多个 skill 包
// ---------------------------------------------------------------------------

type ExtractedSkill = {
  /** 在 raw root 内的相对目录路径('' 表示就是 root) */
  rootRelDir: string
  /** 报错用名称:rootRelDir 的最后一段(或 raw rootName) */
  sourceName: string
  /** 该 skill 子树的所有文件,relativePath 相对于 skill 根 */
  files: FileEntry[]
}

function extractSkillsFromDirectoryCandidate(
  candidate: RawCandidate,
): ExtractedSkill[] {
  // 找出所有 SKILL.md 的目录路径(相对 root)
  const skillDirs: string[] = []
  for (const file of candidate.files) {
    if (
      !file.relativePath.endsWith(`/${SKILL_MD}`) &&
      file.relativePath !== SKILL_MD
    ) {
      continue
    }
    const dir =
      file.relativePath === SKILL_MD
        ? ''
        : file.relativePath.slice(0, -SKILL_MD.length - 1)
    skillDirs.push(dir)
  }

  if (skillDirs.length === 0) {
    // 没有 SKILL.md → 仍然返回 root,让后续校验报"missing SKILL.md"
    return [
      {
        rootRelDir: '',
        sourceName: candidate.rootName,
        files: candidate.files,
      },
    ]
  }

  // 排除嵌套:若一个 skillDir 是另一个的子孙,则跳过子孙
  skillDirs.sort((a, b) => a.length - b.length)
  const accepted: string[] = []
  for (const dir of skillDirs) {
    const isNested = accepted.some((parent) =>
      parent === '' ? true : dir.startsWith(`${parent}/`),
    )
    if (!isNested) accepted.push(dir)
  }

  return accepted.map((rootRelDir) => {
    const prefix = rootRelDir === '' ? '' : `${rootRelDir}/`
    const files = candidate.files
      .filter((f) =>
        rootRelDir === ''
          ? !accepted.some(
              (other) => other !== '' && f.relativePath.startsWith(`${other}/`),
            )
          : f.relativePath.startsWith(prefix),
      )
      .map((f) => ({
        relativePath:
          rootRelDir === ''
            ? f.relativePath
            : f.relativePath.slice(prefix.length),
        content: f.content,
      }))
    const sourceName =
      rootRelDir === ''
        ? candidate.rootName
        : (rootRelDir.split('/').pop() ?? candidate.rootName)
    return { rootRelDir, sourceName, files }
  })
}

// ---------------------------------------------------------------------------
// 路径安全:确保相对路径解析后仍在目标目录内
// ---------------------------------------------------------------------------

function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath) return false
  if (relativePath.startsWith('/') || relativePath.startsWith('\\'))
    return false
  // Windows 风格 / 绝对路径 / 父级回退
  if (/(^|\/)\.\.(\/|$)/.test(relativePath)) return false
  if (/\\/.test(relativePath)) return false
  if (/^[a-zA-Z]:/.test(relativePath)) return false
  return true
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

function ImportSkillModalContent({
  app,
  onImported,
  onClose,
}: Omit<ImportSkillModalProps, 'plugin'> & { onClose: () => void }) {
  const { t } = useLanguage()
  const { settings } = useSettings()
  const skillsDir = getYoloSkillsDir(settings)

  const [skillPackages, setSkillPackages] = useState<SkillPackage[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const buildSkillPackagesFromCandidates = useCallback(
    (
      candidates: RawCandidate[],
    ): { valid: SkillPackage[]; errors: string[] } => {
      const valid: SkillPackage[] = []
      const errors: string[] = []
      const seenTargets = new Set<string>()
      const pushValid = (pkg: SkillPackage) => {
        if (seenTargets.has(pkg.targetName)) {
          errors.push(
            t(
              'settings.agent.importSkillDuplicateInBatch',
              'Duplicate skill name in this batch: "{name}" (from "{source}"). Only the first occurrence is kept.',
            )
              .replace('{name}', pkg.targetName)
              .replace('{source}', pkg.sourceName),
          )
          return
        }
        seenTargets.add(pkg.targetName)
        valid.push(pkg)
      }

      for (const candidate of candidates) {
        // 路径安全校验(整批候选,提前拦截 — 任意一个文件不安全就丢弃整包)
        const unsafe = candidate.files.find(
          (f) => !isSafeRelativePath(f.relativePath),
        )
        if (unsafe) {
          errors.push(
            t(
              'settings.agent.importSkillUnsafePath',
              'Refused unsafe path in "{name}": {path}',
            )
              .replace('{name}', candidate.rootName)
              .replace('{path}', unsafe.relativePath),
          )
          continue
        }

        if (candidate.isSingleFile) {
          const content = candidate.files[0]?.content ?? ''
          const validationErrors = validateSingleFileSkill(content)
          if (validationErrors.length > 0) {
            errors.push(
              formatValidationErrors(validationErrors, candidate.rootName, t),
            )
            continue
          }
          const fm = parseFrontmatter(content)
          const fmName =
            typeof fm?.name === 'string' && fm.name.trim()
              ? fm.name.trim()
              : null
          const description =
            (typeof fm?.description === 'string' && fm.description.trim()) || ''
          if (!isSafeRelativePath(candidate.rootName)) {
            errors.push(
              t(
                'settings.agent.importSkillUnsafePath',
                'Refused unsafe path in "{name}": {path}',
              )
                .replace('{name}', candidate.rootName)
                .replace('{path}', candidate.rootName),
            )
            continue
          }
          pushValid({
            sourceName: candidate.rootName,
            targetName: candidate.rootName,
            displayName: fmName ?? candidate.rootName,
            description,
            files: candidate.files,
            isDirectory: false,
          })
          continue
        }

        // 目录模式:展开嵌套
        const extracted = extractSkillsFromDirectoryCandidate(candidate)
        for (const skill of extracted) {
          const validationErrors = validateDirectoryPackage(
            skill.sourceName,
            skill.files,
          )
          if (validationErrors.length > 0) {
            errors.push(
              formatValidationErrors(validationErrors, skill.sourceName, t),
            )
            continue
          }
          const skillMd = skill.files.find((f) => f.relativePath === SKILL_MD)
          const fm = parseFrontmatter(skillMd?.content ?? '')
          const fmName =
            typeof fm?.name === 'string' && fm.name.trim()
              ? fm.name.trim()
              : skill.sourceName
          const description =
            (typeof fm?.description === 'string' && fm.description.trim()) || ''
          pushValid({
            sourceName: skill.sourceName,
            targetName: fmName,
            displayName: fmName,
            description,
            files: skill.files,
            isDirectory: true,
          })
        }
      }

      return { valid, errors }
    },
    [t],
  )

  const detectConflicts = useCallback(
    (packages: SkillPackage[]) => {
      const conflicts: SkillPackage[] = []
      const noConflict: SkillPackage[] = []
      for (const pkg of packages) {
        const targetPath = normalizePath(`${skillsDir}/${pkg.targetName}`)
        if (app.vault.getAbstractFileByPath(targetPath)) {
          conflicts.push(pkg)
        } else {
          noConflict.push(pkg)
        }
      }
      return { conflicts, noConflict }
    },
    [app, skillsDir],
  )

  const mergeIntoList = useCallback((additions: SkillPackage[]) => {
    setSkillPackages((prev) => {
      const seen = new Set(prev.map((p) => p.targetName))
      const deduped = additions.filter((p) => !seen.has(p.targetName))
      return [...prev, ...deduped]
    })
  }, [])

  const addCandidates = useCallback(
    (candidates: RawCandidate[]) => {
      if (candidates.length === 0) {
        new Notice(
          t(
            'settings.agent.importSkillInvalidFile',
            'No valid skill files or packages found.',
          ),
        )
        return
      }

      const { valid, errors } = buildSkillPackagesFromCandidates(candidates)

      if (errors.length > 0) {
        new Notice(errors.join('\n\n'))
      }

      if (valid.length === 0) return

      const { conflicts, noConflict } = detectConflicts(valid)
      if (conflicts.length === 0) {
        mergeIntoList(valid)
        return
      }

      // 列出冲突 + 三选项
      const conflictList = conflicts.map((p) => p.targetName).join(', ')
      const message = t(
        'settings.agent.importSkillConflictMessageList',
        'The following skill(s) already exist: {names}\n\nOverwrite all, skip conflicts, or cancel?',
      ).replace('{names}', conflictList)
      const modal = new ConfirmModal(app, {
        title: t(
          'settings.agent.importSkillConflictTitle',
          'Skill already exists',
        ),
        message,
        ctaText: t(
          'settings.agent.importSkillConflictOverwrite',
          'Overwrite all',
        ),
        cancelText: t(
          'settings.agent.importSkillConflictSkip',
          'Skip conflicts',
        ),
        onConfirm: () => mergeIntoList(valid),
        onCancel: () => {
          if (noConflict.length > 0) mergeIntoList(noConflict)
        },
      })
      modal.open()
    },
    [app, buildSkillPackagesFromCandidates, detectConflicts, mergeIntoList, t],
  )

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return

      try {
        const candidates = await readRawCandidatesFromFileList(files)
        addCandidates(candidates)
      } catch {
        new Notice(
          t('settings.agent.importSkillReadError', 'Failed to read files.'),
        )
      }
      e.target.value = ''
    },
    [addCandidates, t],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)

      const items = e.dataTransfer.items
      if (items && items.length > 0) {
        try {
          const candidates = await readRawCandidatesFromDataTransfer(items)
          addCandidates(candidates)
        } catch {
          new Notice(
            t('settings.agent.importSkillReadError', 'Failed to read files.'),
          )
        }
      }
    },
    [addCandidates, t],
  )

  const handleRemovePackage = useCallback((targetName: string) => {
    setSkillPackages((prev) => prev.filter((p) => p.targetName !== targetName))
  }, [])

  const handleImport = useCallback(async () => {
    if (skillPackages.length === 0) return

    setIsImporting(true)

    try {
      const { successCount, errors } = await writeSkillPackages(
        app,
        skillsDir,
        skillPackages,
      )

      if (errors.length > 0) {
        new Notice(
          errors
            .map((e) => {
              const colonIdx = e.indexOf(': ')
              const name = colonIdx > 0 ? e.slice(0, colonIdx) : e
              const error = colonIdx > 0 ? e.slice(colonIdx + 2) : ''
              return t(
                'settings.agent.importSkillWriteError',
                'Failed to import {name}: {error}',
              )
                .replace('{name}', name)
                .replace('{error}', error)
            })
            .join('\n\n'),
        )
      }

      if (successCount > 0) {
        new Notice(
          t(
            'settings.agent.importSkillSuccess',
            'Successfully imported {count} skill(s).',
          ).replace('{count}', String(successCount)),
        )
        onImported?.()
        onClose()
      }
    } finally {
      setIsImporting(false)
    }
  }, [app, skillPackages, skillsDir, t, onImported, onClose])

  const totalFileCount = skillPackages.reduce(
    (sum, pkg) => sum + pkg.files.length,
    0,
  )

  return (
    <div className="yolo-import-skill-modal">
      <div className="yolo-settings-desc yolo-settings-callout">
        {t(
          'settings.agent.importSkillDesc',
          'Import skill packages into {path}. Supports single .md files or Agent Skills standard folders (containing SKILL.md, scripts/, references/, etc.).',
        ).replace('{path}', skillsDir)}
      </div>

      <div
        className={`yolo-import-skill-dropzone ${isDragOver ? 'is-drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => void handleDrop(e)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            fileInputRef.current?.click()
          }
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown"
          multiple
          onChange={(e) => void handleFileSelect(e)}
          className="yolo-import-skill-hidden-input"
        />
        <input
          ref={folderInputRef}
          type="file"
          // @ts-expect-error -- webkitdirectory 是非标准属性但广泛支持
          webkitdirectory=""
          multiple
          onChange={(e) => void handleFileSelect(e)}
          className="yolo-import-skill-hidden-input"
        />
        <div className="yolo-import-skill-dropzone-text">
          {t(
            'settings.agent.importSkillDropzoneText',
            'Drag & drop skill files or folders here',
          )}
        </div>
        <div className="yolo-import-skill-dropzone-buttons">
          <button
            type="button"
            className="yolo-import-skill-browse-btn"
            onClick={(e) => {
              e.stopPropagation()
              fileInputRef.current?.click()
            }}
          >
            {t('settings.agent.importSkillBrowseFiles', 'Browse Files')}
          </button>
          <button
            type="button"
            className="yolo-import-skill-browse-btn"
            onClick={(e) => {
              e.stopPropagation()
              folderInputRef.current?.click()
            }}
          >
            {t('settings.agent.importSkillBrowseFolder', 'Browse Folder')}
          </button>
        </div>
      </div>

      {skillPackages.length > 0 && (
        <div className="yolo-import-skill-file-list">
          <div className="yolo-import-skill-file-list-title">
            {t(
              'settings.agent.importSkillFileCount',
              '{count} skill(s) selected ({files} files total)',
            )
              .replace('{count}', String(skillPackages.length))
              .replace('{files}', String(totalFileCount))}
          </div>
          {skillPackages.map((pkg) => (
            <div key={pkg.targetName} className="yolo-import-skill-file-item">
              <div className="yolo-import-skill-file-info">
                <span className="yolo-import-skill-file-name">
                  {pkg.displayName}
                </span>
                {pkg.description && (
                  <span className="yolo-import-skill-file-desc">
                    {pkg.description}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="yolo-import-skill-file-remove"
                onClick={() => handleRemovePackage(pkg.targetName)}
                aria-label={t('settings.agent.importSkillRemoveFile', 'Remove')}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="yolo-import-skill-actions">
        <ObsidianButton
          text={t('settings.agent.importSkillConfirm', 'Import')}
          cta
          disabled={skillPackages.length === 0 || isImporting}
          onClick={() => void handleImport()}
        />
      </div>
    </div>
  )
}
