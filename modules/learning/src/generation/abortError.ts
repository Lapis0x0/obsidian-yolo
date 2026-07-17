export class LearningGenerationAbortError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AbortError'
  }
}
