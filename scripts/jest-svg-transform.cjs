// Jest has no SVG asset loader (unlike esbuild's production bundling, which
// inlines these as data: URIs). This transform stubs each `*.svg` file's
// content with a small CJS module exporting the file's own absolute path as
// its default export — deterministic and, crucially, unique per source file.
//
// A shared `moduleNameMapper` entry pointing every `*.svg` import at one
// mock file was tried first and rejected: it collapses every icon into the
// same resolved module id, so per-file `jest.mock('icon.svg', factory)`
// overrides (see RuntimeSelector.test.tsx) collide and the last-registered
// mock wins for all of them. A transform preserves each file's own resolved
// identity, so those per-file overrides keep working.
module.exports = {
  process(_src, filename) {
    return {
      code: `module.exports = { __esModule: true, default: ${JSON.stringify(filename)} };`,
    }
  },
}
