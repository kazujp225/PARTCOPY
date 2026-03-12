import { describe, it, expect } from 'vitest'
import { FAMILY_COLORS } from '../constants'

const EXPECTED_FAMILIES = [
  'navigation',
  'hero',
  'feature',
  'social_proof',
  'stats',
  'pricing',
  'faq',
  'content',
  'cta',
  'contact',
  'recruit',
  'footer',
  'news_list',
  'timeline',
  'company_profile',
  'gallery',
  'logo_cloud'
]

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

describe('FAMILY_COLORS', () => {
  it('contains all expected block family keys', () => {
    for (const family of EXPECTED_FAMILIES) {
      expect(FAMILY_COLORS).toHaveProperty(family)
    }
  })

  it('does not contain unexpected keys', () => {
    const keys = Object.keys(FAMILY_COLORS)
    for (const key of keys) {
      expect(EXPECTED_FAMILIES).toContain(key)
    }
  })

  it('has valid hex color values for every entry', () => {
    for (const [key, value] of Object.entries(FAMILY_COLORS)) {
      expect(value, `${key} should be a valid hex color`).toMatch(HEX_COLOR_RE)
    }
  })

  it('has the correct number of entries', () => {
    expect(Object.keys(FAMILY_COLORS).length).toBe(EXPECTED_FAMILIES.length)
  })
})
