/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+.tsx?$': ['ts-jest', {}],
  },
  testPathIgnorePatterns: [
    '<rootDir>/src/components/chat-view/system-prompt/__tests__/setup-jest.ts'
  ],
}
