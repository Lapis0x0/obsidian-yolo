import {
  OUTLINE_SIDEBAR_MAX_WIDTH,
  OUTLINE_SIDEBAR_MIN_WIDTH,
  clampOutlineSidebarWidth,
} from './OutlineView'

describe('clampOutlineSidebarWidth', () => {
  it('rounds and clamps resize input', () => {
    expect(clampOutlineSidebarWidth(100)).toBe(OUTLINE_SIDEBAR_MIN_WIDTH)
    expect(clampOutlineSidebarWidth(301.6)).toBe(302)
    expect(clampOutlineSidebarWidth(500)).toBe(OUTLINE_SIDEBAR_MAX_WIDTH)
  })
})
