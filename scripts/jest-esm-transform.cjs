// The unified/micromark packages ship ESM only, which Jest's CommonJS runtime
// cannot load. esbuild is already a build dependency, so use it to transpile
// those specific packages to CommonJS on the fly. Which packages reach this
// transformer is controlled by `transformIgnorePatterns` in jest.config.js.
const { transformSync } = require('esbuild')

module.exports = {
  process(sourceText, sourcePath) {
    const { code } = transformSync(sourceText, {
      loader: 'js',
      format: 'cjs',
      target: 'node18',
      sourcefile: sourcePath,
      sourcemap: 'inline',
    })
    return { code }
  },
  getCacheKey(sourceText, sourcePath) {
    return require('crypto')
      .createHash('sha1')
      .update(sourceText)
      .update('\0')
      .update(sourcePath)
      .digest('hex')
  },
}
