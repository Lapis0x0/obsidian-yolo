export type LearningSrsStorageReadResult = {
  path: string
  content: string
}

export type LearningSrsStorage = {
  getLocationKey(): string
  ensureRoot(): Promise<string>
  ensure(projectSlug: string): Promise<string>
  read(projectSlug: string): Promise<LearningSrsStorageReadResult | null>
  write(projectSlug: string, content: string): Promise<void>
  remove(projectSlug: string): Promise<boolean>
}
