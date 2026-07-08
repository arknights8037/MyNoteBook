import katex from 'katex'
import { describe, expect, it } from 'vitest'

import { MATH_PANEL_TABS, MATH_STRUCTURE_SNIPPETS, MATH_SYMBOL_GROUPS } from './mathInputCatalog'

describe('mathInputCatalog', () => {
  it('provides direct symbol groups for operators, relations, letters, sets, and common math', () => {
    expect(MATH_PANEL_TABS.map((tab) => tab.id)).toEqual([
      'structure',
      'operator',
      'relation',
      'letter',
      'set',
      'common',
    ])
    expect(MATH_SYMBOL_GROUPS.letter.map((symbol) => symbol.label)).toEqual(
      expect.arrayContaining(['α', 'π', 'ω', 'Γ', 'Σ', 'Ω', 'ℏ']),
    )
    expect(MATH_SYMBOL_GROUPS.set.map((symbol) => symbol.label)).toEqual(
      expect.arrayContaining(['∈', '⊆', '∪', 'ℕ', 'ℤ', 'ℚ', 'ℝ', 'ℂ', '∀', '∃']),
    )
  })

  it('only contains KaTeX-supported snippets and symbols', () => {
    const values = [
      ...MATH_STRUCTURE_SNIPPETS.map((snippet) => snippet.value),
      ...Object.values(MATH_SYMBOL_GROUPS).flatMap((symbols) =>
        symbols.map((symbol) => symbol.value),
      ),
    ]

    for (const value of values) {
      expect(() => katex.renderToString(value, { throwOnError: true })).not.toThrow()
    }
  })
})
