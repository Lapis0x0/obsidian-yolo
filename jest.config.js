/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  roots: ['<rootDir>/src'],
  testEnvironment: 'node',
  transform: {
    '^.+.tsx?$': ['ts-jest', {}],
  },
  testPathIgnorePatterns: ['<rootDir>/Reference/', '<rootDir>/.opencode/'],
  modulePathIgnorePatterns: ['<rootDir>/Reference/', '<rootDir>/.opencode/'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/__mocks__/obsidian.ts',
  },
}
