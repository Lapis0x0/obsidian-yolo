import {
  RESERVED_MODULE_MODE_SERVER_PREFIX,
  validateServerName,
} from './tool-name-utils'

describe('validateServerName', () => {
  it('accepts an ordinary alphanumeric/hyphen/underscore name', () => {
    expect(() => validateServerName('my-server_1')).not.toThrow()
  })

  it('rejects a name with disallowed characters', () => {
    expect(() => validateServerName('bad name!')).toThrow(
      /Invalid MCP server name/,
    )
  })

  it('rejects a name containing the delimiter', () => {
    expect(() => validateServerName('foo__bar')).toThrow(/delimiter/)
  })

  it('respects a custom delimiter', () => {
    // Delimiter characters must themselves be legal server-name characters
    // ([a-zA-Z0-9_-]) for this to isolate the delimiter check from the
    // character-set check.
    expect(() => validateServerName('foo--bar', { delimiter: '--' })).toThrow(
      /delimiter/,
    )
    expect(() =>
      validateServerName('foo__bar', { delimiter: '--' }),
    ).not.toThrow()
  })

  it('rejects a name using the reserved module chat mode prefix by default', () => {
    expect(() =>
      validateServerName(`${RESERVED_MODULE_MODE_SERVER_PREFIX}learning-chat`),
    ).toThrow(/reserved/)
  })

  it('allows the reserved prefix when explicitly opted in', () => {
    expect(() =>
      validateServerName(`${RESERVED_MODULE_MODE_SERVER_PREFIX}learning-chat`, {
        allowReservedPrefix: true,
      }),
    ).not.toThrow()
  })

  it('does not treat a name that merely contains the reserved prefix mid-string as reserved', () => {
    expect(() =>
      validateServerName(`prefixed-${RESERVED_MODULE_MODE_SERVER_PREFIX}x`),
    ).not.toThrow()
  })
})
