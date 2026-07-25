import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const jestBin = require.resolve('jest/bin/jest')
const child = spawn(
  process.execPath,
  [
    '--experimental-vm-modules',
    jestBin,
    'src/core/runtime-components/pgliteEngine.integration.test.ts',
    '--runInBand',
    '--forceExit',
  ],
  { stdio: 'inherit' },
)

child.once('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`PGlite runtime integration test stopped by ${signal}`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
