import type { CardRect } from './resize'
import { snapMove, snapResize } from './snapping'

const rect = (x: number, y: number, w = 100, h = 60): CardRect => ({
  x,
  y,
  w,
  h,
})

const options = { tolerance: 10, gridStep: 0 }

describe('snapMove', () => {
  it('lines a near-miss left edge up with the card above it', () => {
    const result = snapMove([rect(103, 200)], [rect(100, 0)], {
      ...options,
      movedX: true,
      movedY: true,
    })
    expect(result.dx).toBe(-3)
    expect(result.dy).toBe(0)
  })

  it('leaves a miss beyond the tolerance alone', () => {
    const result = snapMove([rect(115, 200)], [rect(100, 0)], {
      ...options,
      movedX: true,
      movedY: true,
    })
    expect(result).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it('takes the nearest alignment when several are on offer', () => {
    // Right edge of the moving card is 2 from the neighbour's left edge;
    // its left edge is 8 from that neighbour's left edge.
    const result = snapMove([rect(292, 0)], [rect(400, 0)], {
      ...options,
      movedX: true,
      movedY: false,
    })
    expect(result.dx).toBe(8)
  })

  it('aligns centres, not only edges', () => {
    // Moving centre x = 254, target centre x = 250.
    const result = snapMove([rect(204, 500)], [rect(200, 0)], {
      ...options,
      movedX: true,
      movedY: false,
    })
    expect(result.dx).toBe(-4)
  })

  it('never moves an axis the gesture did not', () => {
    const result = snapMove([rect(103, 3)], [rect(100, 0)], {
      ...options,
      movedX: true,
      movedY: false,
    })
    expect(result).toMatchObject({ dx: -3, dy: 0 })
  })

  it('decides the two axes independently', () => {
    const result = snapMove([rect(103, 1000)], [rect(100, 0)], {
      tolerance: 10,
      gridStep: 20,
      movedX: true,
      movedY: true,
    })
    // x found a card to line up with; y found none and fell to the lattice.
    expect(result.dx).toBe(-3)
    expect(result.dy).toBe(0)
  })

  it('falls back to the grid on an axis with nothing to align to', () => {
    const result = snapMove([rect(103, 47)], [], {
      tolerance: 10,
      gridStep: 20,
      movedX: true,
      movedY: true,
    })
    expect(result.dx).toBe(-3)
    expect(result.dy).toBe(-7)
    expect(result.guides).toEqual([])
  })

  it('measures the grid from the whole selection, keeping its spacing', () => {
    const result = snapMove([rect(47, 0), rect(200, 0)], [], {
      tolerance: 10,
      gridStep: 20,
      movedX: true,
      movedY: false,
    })
    expect(result.dx).toBe(-7)
  })

  it('describes what lined up, with the correction already applied', () => {
    // A wider neighbour, so only the two left edges are in reach of each
    // other and the guide is unambiguous.
    const result = snapMove([rect(103, 200)], [rect(100, 0, 140)], {
      ...options,
      movedX: true,
      movedY: false,
    })
    expect(result.guides).toEqual([
      {
        axis: 'x',
        position: 100,
        from: 0,
        to: 260,
        marks: [200, 260, 0, 60],
      },
    ])
  })

  it('marks every card that shares the alignment', () => {
    const result = snapMove(
      [rect(103, 400)],
      [rect(100, 0, 140), rect(100, 200, 140)],
      {
        ...options,
        movedX: true,
        movedY: false,
      },
    )
    expect(result.guides).toHaveLength(1)
    expect(result.guides[0].marks).toHaveLength(6)
  })

  it('draws every alignment one correction produces', () => {
    // Same-sized cards meeting: left, centre and right all line up at once,
    // which is three lines, not one.
    const result = snapMove([rect(103, 200)], [rect(100, 0)], {
      ...options,
      movedX: true,
      movedY: false,
    })
    expect(result.guides.map((guide) => guide.position).sort()).toEqual([
      100, 150, 200,
    ])
  })

  it('keeps the same alignments as the pointer moves within them', () => {
    // Two same-sized cards meeting line up three times over for one
    // correction, and each of the three computes that correction as its own
    // subtraction, which agree only to the last bit. Compared exactly, the
    // set of guides changes with every sub-pixel of movement and flickers.
    const counts = new Set<number>()
    for (let step = 0; step < 40; step += 1) {
      const result = snapMove(
        [rect(726 + step * 0.017, 2084)],
        [rect(720, 2080)],
        { tolerance: 16, gridStep: 20, movedX: true, movedY: true },
      )
      counts.add(result.guides.filter((guide) => guide.axis === 'x').length)
    }
    expect([...counts]).toEqual([3])
  })

  it('has nothing to say about an empty gesture', () => {
    expect(
      snapMove([], [rect(0, 0)], { ...options, movedX: true, movedY: true }),
    ).toEqual({ dx: 0, dy: 0, guides: [] })
  })
})

describe('snapResize', () => {
  it('lines the dragged edge up and leaves the fixed one alone', () => {
    // Dragging the right edge, which lands 3 short of the neighbour's right.
    const result = snapResize(rect(0, 0, 97), 'right', [rect(0, 200, 100)], {
      ...options,
    })
    expect(result.dx).toBe(3)
    expect(result.dy).toBe(0)
  })

  it('ignores an alignment the handle cannot reach', () => {
    // The *left* edge is 3 from the neighbour's left, but this handle only
    // moves the right one, and the right one is nowhere near anything.
    const result = snapResize(rect(103, 0, 300), 'right', [rect(100, 200)], {
      ...options,
    })
    expect(result.dx).toBe(0)
  })

  it('snaps both edges of a corner handle', () => {
    const result = snapResize(
      rect(3, 4, 100, 60),
      'topleft',
      [rect(0, 0, 500, 500)],
      options,
    )
    expect(result).toMatchObject({ dx: -3, dy: -4 })
  })

  it('falls back to the grid for the dragged edge', () => {
    const result = snapResize(rect(0, 0, 97, 60), 'right', [], {
      tolerance: 10,
      gridStep: 20,
    })
    // The right edge sits at 97, three short of the lattice line at 100.
    expect(result.dx).toBe(3)
    expect(result.dy).toBe(0)
  })

  it('leaves an axis its handle does not move entirely alone', () => {
    const result = snapResize(rect(0, 47, 97, 60), 'right', [], {
      tolerance: 10,
      gridStep: 20,
    })
    expect(result.dy).toBe(0)
  })
})
