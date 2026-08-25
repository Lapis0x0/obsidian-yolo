import { extractKnownFailure, extractToken } from './setupToken'

const ESC = '\x1b'
const CSI = (code: string) => `${ESC}[${code}`
const OSC_LINK = (url: string) => `${ESC}]8;id=x;${url}${ESC}\\`

describe('extractToken', () => {
  it('extracts a token printed on a single line with no wrapping', () => {
    const token =
      'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const transcript = `${CSI('1B')} Your OAuth token (valid for 1 year):${CSI(
      'K',
    )}${CSI('1B')} ${token}${CSI('1C')}${CSI('2B')}Store${CSI('8G')}this`

    expect(extractToken(transcript)).toBe(token)
  })

  it('takes the whole run a row holds and nothing from the next row', () => {
    // The real transcript shape: the TUI paints the token at an absolute
    // column as one contiguous run, ends the row, and paints the next cell.
    // Carrying anything across that boundary would silently lengthen the
    // token, exactly as wrapping used to silently shorten it.
    const token = `sk-ant-oat01-${'B'.repeat(74)}-CCCCCC`
    const transcript = `${CSI('2G')}${token}\r\r\n${CSI(
      '2G',
    )}Store${CSI('8G')}this${CSI('13G')}securely`

    expect(extractToken(transcript)).toBe(token)
  })

  it('does not swallow unrelated text that follows a hard boundary escape', () => {
    const token =
      'sk-ant-oat01-EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE'
    const transcript = `${CSI('1B')} ${token}${CSI('1C')}${CSI(
      '2B',
    )}Storethistokensecurely`

    expect(extractToken(transcript)).toBe(token)
  })

  it('ignores OSC hyperlink noise (e.g. the earlier authorize-URL prompt)', () => {
    const transcript = `Browser didn't open? Use the url below${OSC_LINK(
      'https://claude.com/cai/oauth/authorize?code=true',
    )}`

    expect(extractToken(transcript)).toBeNull()
  })

  it('returns null when no token has been printed yet', () => {
    expect(extractToken('Opening browser to sign in…')).toBeNull()
  })
})

describe('extractKnownFailure', () => {
  it('detects a known failure snippet', () => {
    const transcript = `${CSI('1B')} Failed to exchange authorization code for access token. Please try again.`
    expect(extractKnownFailure(transcript)).toBe(
      'Failed to exchange authorization code',
    )
  })

  it('returns null for unrelated output', () => {
    expect(extractKnownFailure('Opening browser to sign in…')).toBeNull()
  })
})
