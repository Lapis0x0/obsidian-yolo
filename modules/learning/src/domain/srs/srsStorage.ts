export type SrsStorageReadResult = {
  path: string
  content: string
}

export type SrsStorage = {
  getLocationKey(): string
  ensureRoot(): Promise<string>
  ensure(projectSlug: string): Promise<string>
  exists(projectSlug: string): Promise<boolean>
  read(projectSlug: string): Promise<SrsStorageReadResult | null>
  write(projectSlug: string, content: string): Promise<string>
  writeProjectStateAtPath(
    projectSlug: string,
    path: string,
    content: string,
  ): Promise<void>
  remove(projectSlug: string): Promise<boolean>
  existsProjectStateAtPath(projectSlug: string, path: string): Promise<boolean>
  removeProjectStateAtPath(projectSlug: string, path: string): Promise<boolean>
}
