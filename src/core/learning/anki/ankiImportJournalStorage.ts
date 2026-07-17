export type AnkiImportJournalStorage = {
  create(content: string): Promise<string>
  write(path: string, content: string): Promise<void>
  list(): Promise<readonly string[]>
  read(path: string): Promise<string>
  remove(path: string): Promise<void>
}
