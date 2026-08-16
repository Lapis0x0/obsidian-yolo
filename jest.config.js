/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  roots: ['<rootDir>/src', '<rootDir>/modules'],
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/__mocks__/runtimeComponentTestSetup.ts'],
  transform: {
    '^.+.tsx?$': ['ts-jest', { isolatedModules: true }],
    '^.+\\.m?js$': '<rootDir>/scripts/jest-esm-transform.cjs',
    '\\.svg$': '<rootDir>/scripts/jest-svg-transform.cjs',
    '\\.md$': '<rootDir>/scripts/jest-md-transform.cjs',
  },
  // Only the ESM-only markdown parsing chain and the ACP SDK (also ESM-only)
  // need transpiling; everything else in node_modules stays untransformed.
  transformIgnorePatterns: [
    '/node_modules/(?!(mdast-util-from-markdown|mdast-util-to-string|micromark|micromark-[a-z-]+|character-entities|decode-named-character-reference|devlop|unist-util-stringify-position|@agentclientprotocol/sdk)/)',
  ],
  testPathIgnorePatterns: ['<rootDir>/Reference/', '<rootDir>/.opencode/'],
  modulePathIgnorePatterns: ['<rootDir>/Reference/', '<rootDir>/.opencode/'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/__mocks__/obsidian.ts',
    '^virtual:.*$': '<rootDir>/__mocks__/virtual.ts',
    // path-browserify ships CommonJS; its default import resolves to undefined
    // under ts-jest. Re-export Node's built-in path (identical API) instead.
    '^path-browserify$': '<rootDir>/__mocks__/path-browserify.ts',
    // just-bash's "./browser" export only declares an ESM "import" condition,
    // which Jest's CJS resolver can't load. Redirect to the package's CJS
    // main bundle for tests only — same public API (Bash, defineCommand,
    // getCommandNames, ...), just packaged differently. Production code
    // (runtime-components/bash-engine/src/entry.ts) still resolves the real
    // browser subpath via esbuild at build time; this mapping never affects it.
    '^just-bash/browser$': '<rootDir>/node_modules/just-bash/dist/bundle/index.cjs',
  },
}
