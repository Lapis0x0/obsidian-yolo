import { FramePace } from './framePace'

describe('FramePace', () => {
  it('judges a frame against the display it is drawn for', () => {
    const at120 = new FramePace(1.5)
    for (let i = 0; i < 10; i++) expect(at120.onTime(8.3)).toBe(true)
    // Two periods late at 120Hz, though under the old fixed 20ms bar.
    expect(at120.onTime(16.7)).toBe(false)

    const at60 = new FramePace(1.5)
    for (let i = 0; i < 10; i++) expect(at60.onTime(16.7)).toBe(true)
    expect(at60.onTime(16.9)).toBe(true)
    expect(at60.onTime(33.4)).toBe(false)
  })

  it('takes the first frame after a pause, or a second callback in one frame, as on time', () => {
    const pace = new FramePace(1.5)
    expect(pace.onTime(0)).toBe(true)
    pace.onTime(8.3)
    expect(pace.onTime(1)).toBe(true)
    // …without reading the display's period off it.
    expect(pace.onTime(12)).toBe(true)
  })

  it('forgets a faster display once its frames have left the window', () => {
    const pace = new FramePace(1.5)
    pace.onTime(8.3)
    for (let i = 0; i < 32; i++) pace.onTime(16.7)
    expect(pace.onTime(20)).toBe(true)
  })
})
