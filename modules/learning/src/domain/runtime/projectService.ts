import type { ScanResult } from '../projectScanner'
import type { LearningProjectScannerPort } from '../stats/ports'

export type LearningProjectServiceOptions = {
  getLearningBaseDir: () => string
  scanner: LearningProjectScannerPort
}

/** Resolves the current managed root for every scan. */
export class LearningProjectService {
  constructor(private readonly options: LearningProjectServiceOptions) {}

  getLearningBaseDir(): string {
    return this.options.getLearningBaseDir()
  }

  scanProjects(): Promise<ScanResult> {
    return this.options.scanner.scanProjects(this.getLearningBaseDir())
  }
}
