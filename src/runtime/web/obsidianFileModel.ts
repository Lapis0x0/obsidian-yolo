export type BasicFileStats = {
  ctime: number
  mtime: number
  size: number
  type?: 'file' | 'folder'
}

export function normalizePath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '') || '/'
}

export class TAbstractFile {
  parent: TFolder | null = null
  deleted = false
  vault: unknown = null
  path = ''
  name = ''

  constructor(vaultOrPath?: unknown, pathOrName?: string) {
    if (typeof vaultOrPath === 'string') {
      this.setPath(vaultOrPath)
      return
    }

    this.vault = vaultOrPath ?? null
    if (typeof pathOrName === 'string') {
      this.setPath(pathOrName)
    }
  }

  setPath(path: string): void {
    this.path = normalizePath(path)
    this.name = this.path.split('/').pop() || ''
  }

  getNewPathAfterRename(name: string): string {
    const parent = this.parent
    if (!parent) {
      return ''
    }
    return parent.isRoot() ? name : `${parent.path}/${name}`
  }
}

export class TFile extends TAbstractFile {
  saving = false
  stat: BasicFileStats = {
    ctime: 0,
    mtime: 0,
    size: 0,
  }
  basename = ''
  extension = ''

  constructor(vaultOrPath?: unknown, pathOrBasename?: string, _extension?: string) {
    const isPathOnly = typeof vaultOrPath === 'string'
    super(isPathOnly ? null : vaultOrPath, isPathOnly ? vaultOrPath : pathOrBasename)

    // Base constructor dispatches to this override before subclass field
    // initializers run, so recompute file metadata after super().
    if (isPathOnly) {
      this.setPath(vaultOrPath)
    } else if (typeof pathOrBasename === 'string') {
      this.setPath(pathOrBasename)
    }
  }

  override setPath(path: string): void {
    super.setPath(path)
    const dot = this.name.lastIndexOf('.')
    this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name
    this.extension = dot >= 0 ? this.name.slice(dot + 1) : ''
  }

  getShortName(): string {
    return this.extension === 'md' ? this.basename : this.name
  }
}

export class TFolder extends TAbstractFile {
  children: Array<TFile | TFolder> = []

  constructor(vaultOrPath?: unknown, pathOrName?: string) {
    const isPathOnly = typeof vaultOrPath === 'string'
    super(isPathOnly ? null : vaultOrPath, isPathOnly ? vaultOrPath : pathOrName)
  }

  isRoot(): boolean {
    return this.path === '/'
  }

  getParentPrefix(): string {
    return this.isRoot() ? '' : `${this.path}/`
  }

  getFileCount(): number {
    let count = 0
    for (const child of this.children) {
      count += child instanceof TFolder ? child.getFileCount() : 1
    }
    return count
  }
}
