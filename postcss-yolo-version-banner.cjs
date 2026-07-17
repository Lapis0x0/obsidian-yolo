const fs = require('fs')
const path = require('path')

const manifestPath = path.join(__dirname, 'manifest.json')

function readManifestVersion() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const version =
    typeof manifest.version === 'string' ? manifest.version.trim() : ''
  if (!version) {
    throw new Error('manifest.json is missing version')
  }
  return version
}

/** Prepends or updates the @yolo-version comment on every styles build (incl. watch). */
function yoloVersionBanner() {
  return {
    postcssPlugin: 'yolo-version-banner',
    Once(root) {
      const version = readManifestVersion()
      const bannerText = `@yolo-version: ${version}`
      const first = root.first

      if (
        first?.type === 'comment' &&
        /^\s*@yolo-version:/.test(first.text)
      ) {
        first.text = bannerText
        return
      }

      root.prepend({ type: 'comment', text: bannerText })
    },
  }
}

yoloVersionBanner.postcss = true

module.exports = yoloVersionBanner
