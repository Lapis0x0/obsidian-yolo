// The Unicode line breaking algorithm (UAX #14), which ./breaking.ts asks
// where a line may break. The package ships no types.
declare module 'linebreak' {
  export default class LineBreaker {
    constructor(text: string)
    nextBreak(): { position: number; required: boolean } | null
  }
}
