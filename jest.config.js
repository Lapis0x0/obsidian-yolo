/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  roots: ['<rootDir>/src'],
  testEnvironment: 'node',
  transform: {
    '^.+.tsx?$': ['ts-jest', { isolatedModules: true }],
  },
  testPathIgnorePatterns: ['<rootDir>/Reference/', '<rootDir>/.opencode/'],
  modulePathIgnorePatterns: ['<rootDir>/Reference/', '<rootDir>/.opencode/'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/__mocks__/obsidian.ts',
    '^virtual:.*$': '<rootDir>/__mocks__/virtual.ts',
    // path-browserify ships CommonJS; its default import resolves to undefined
    // under ts-jest. Re-export Node's built-in path (identical API) instead.
    '^path-browserify$': '<rootDir>/__mocks__/path-browserify.ts',
  },
}
