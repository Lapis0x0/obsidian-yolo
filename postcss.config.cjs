const yoloVersionBanner = require('./postcss-yolo-version-banner.cjs')

module.exports = {
  plugins: [
    require('postcss-import'),
    require('postcss-nesting'),
    yoloVersionBanner(),
  ],
}
