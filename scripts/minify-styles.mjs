// Minifies the built host styles.css for release. Obsidian reads and parses
// the whole file on every startup, so whitespace and comments cost load time.
// The `@yolo-version` banner must stay the file's first comment in its exact
// shape (parseStylesBakedVersion), so it is re-attached after minification.
import fs from 'fs'

import esbuild from 'esbuild'

const file = 'styles.css'
const css = fs.readFileSync(file, 'utf8')
const banner = css.match(/^\/\*\s*@yolo-version:\s*[^\s*]+\s*\*\//)?.[0]
if (!banner) throw new Error(`${file} is missing the @yolo-version banner`)

const { code } = await esbuild.transform(css, { loader: 'css', minify: true })
fs.writeFileSync(file, `${banner}\n${code}`)
