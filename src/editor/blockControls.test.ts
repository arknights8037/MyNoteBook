import { describe, expect, it } from 'vitest'

import { resolveDropInsertPosition } from './blockControls'

describe('blockControls', () => {
  it('treats dropping on the lower half of the previous adjacent block as an upward swap', () => {
    expect(
      resolveDropInsertPosition(
        { from: 10, to: 20 },
        { from: 0, to: 10 },
        true,
      ),
    ).toBe(0)
  })

  it('treats dropping on the upper half of the next adjacent block as a downward swap', () => {
    expect(
      resolveDropInsertPosition(
        { from: 0, to: 10 },
        { from: 10, to: 20 },
        false,
      ),
    ).toBe(20)
  })

  it('keeps non-adjacent drop positioning unchanged', () => {
    expect(
      resolveDropInsertPosition(
        { from: 20, to: 30 },
        { from: 0, to: 10 },
        true,
      ),
    ).toBe(10)
  })
})
