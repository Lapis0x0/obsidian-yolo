/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  roots: ['<rootDir>/src'],
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', {}],
  },
  testPathIgnorePatterns: ['<rootDir>/Reference/', '<rootDir>/.opencode/'],
  modulePathIgnorePatterns: ['<rootDir>/Reference/', '<rootDir>/.opencode/'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/__mocks__/obsidian.ts',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(marked)/)',
  ],
}
