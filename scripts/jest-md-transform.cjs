// Jest counterpart to esbuild's `.md: text` loader (see esbuild.config.mjs).
// Built-in skills ship as real `SKILL.md` files that the host imports as text,
// so tests must see the file's actual content — unlike the `.svg` transform,
// which only needs a unique stub per file.
module.exports = {
  process(src) {
    return {
      code: `module.exports = { __esModule: true, default: ${JSON.stringify(src)} };`,
    }
  },
}
