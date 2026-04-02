/**
 * Theme Unification Engine
 *
 * 複数セクションの StyleFingerprint + CSS 情報から
 * ページ全体の PageTheme を生成する。
 *
 * strict モード: レイアウト変更禁止。色・タイポ・余白・ボタンのトークン統一のみ。
 */

import type { CanonicalSection, PageTheme, StyleFingerprint, UnifyMode } from './canonical-types.js'
import { DEFAULT_PAGE_THEME } from './canonical-types.js'

// ============================================================
// Color extraction helpers
// ============================================================

interface ColorCount {
  color: string
  count: number
}

function extractColorsFromCss(css: string): ColorCount[] {
  const counts = new Map<string, number>()

  // Hex colors
  const hexMatches = css.match(/#[0-9a-fA-F]{3,8}/g) || []
  for (const hex of hexMatches) {
    const normalized = normalizeHex(hex)
    if (isNeutral(normalized)) continue
    counts.set(normalized, (counts.get(normalized) || 0) + 1)
  }

  // rgb/rgba
  const rgbRe = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g
  let m
  while ((m = rgbRe.exec(css)) !== null) {
    const hex = rgbToHex(+m[1], +m[2], +m[3])
    if (isNeutral(hex)) continue
    counts.set(hex, (counts.get(hex) || 0) + 1)
  }

  return [...counts.entries()]
    .map(([color, count]) => ({ color, count }))
    .sort((a, b) => b.count - a.count)
}

function normalizeHex(hex: string): string {
  let h = hex.toLowerCase()
  if (h.length === 4) {
    h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3]
  }
  return h.slice(0, 7) // strip alpha
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}

function isNeutral(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const maxDiff = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b))
  const avg = (r + g + b) / 3
  // Nearly grayscale or very light/dark
  return maxDiff < 15 || avg > 240 || avg < 15
}

function hexLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function contrastForeground(bgHex: string): string {
  return hexLuminance(bgHex) > 0.5 ? '#ffffff' : '#000000'
}

// ============================================================
// Font extraction helpers
// ============================================================

function extractFontsFromCss(css: string): string[] {
  const fonts = new Map<string, number>()
  const re = /font-family:\s*([^;}{]+)/gi
  let m
  while ((m = re.exec(css)) !== null) {
    const families = m[1].split(',').map(f => f.trim().replace(/['"]/g, ''))
    for (const f of families) {
      if (/^(sans-serif|serif|monospace|cursive|fantasy|system-ui|inherit|initial)$/i.test(f)) continue
      fonts.set(f, (fonts.get(f) || 0) + 1)
    }
  }

  return [...fonts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
}

// ============================================================
// Main theme generation
// ============================================================

export interface ThemeGenerationInput {
  sections: CanonicalSection[]
  cssTexts: string[]  // 各セクションの CSS テキスト
  mode?: UnifyMode
}

/**
 * 複数セクションの情報から PageTheme を生成する。
 * strict モードでは最頻出の値を採用し、レイアウトは変更しない。
 */
export function generatePageTheme(input: ThemeGenerationInput): PageTheme {
  const mode = input.mode || 'strict'
  const allCss = input.cssTexts.join('\n')

  // --- Colors ---
  const colors = extractColorsFromCss(allCss)
  const primary = colors[0]?.color || DEFAULT_PAGE_THEME.colorTokens.primary
  const secondary = colors[1]?.color || DEFAULT_PAGE_THEME.colorTokens.secondary
  const accent = colors[2]?.color || DEFAULT_PAGE_THEME.colorTokens.accent

  const colorTokens: Record<string, string> = {
    primary,
    'primary-foreground': contrastForeground(primary),
    secondary,
    accent,
    background: '#ffffff',
    foreground: '#0f172a',
    muted: '#f1f5f9',
    'muted-foreground': '#64748b',
    border: '#e2e8f0',
  }

  // --- Typography ---
  const fonts = extractFontsFromCss(allCss)
  const headingFont = fonts[0] || DEFAULT_PAGE_THEME.typography.headingFont
  const bodyFont = fonts[1] || fonts[0] || DEFAULT_PAGE_THEME.typography.bodyFont

  // Determine scale from fingerprints
  const fingerprints = input.sections.map(s => s.styleFingerprint)
  const typScale = determineTypographyScale(fingerprints)

  // --- Spacing ---
  const sectionY = determineSectionSpacing(input.sections)

  // --- Corner / Button ---
  const cornerStyle = majorityVote(fingerprints.map(f => f.cornerStyle))
  const buttonRadius = cornerStyle === 'pill' ? 'full' as const
    : cornerStyle === 'soft' ? 'lg' as const
    : 'md' as const

  const shadowLevel = majorityVote(fingerprints.map(f => f.shadowLevel))
  const buttonWeight = shadowLevel >= 2 ? 'solid' as const
    : shadowLevel === 1 ? 'soft' as const
    : 'outline' as const

  // --- Container width ---
  const containerWidth = '2xl' as const  // 安全なデフォルト

  return {
    mode,
    colorTokens,
    typography: {
      bodyFont: wrapFontFamily(bodyFont),
      headingFont: wrapFontFamily(headingFont),
      scale: typScale,
    },
    spacing: {
      sectionY,
      containerWidth,
    },
    buttonStyle: {
      radius: buttonRadius,
      weight: buttonWeight,
    },
  }
}

function wrapFontFamily(font: string): string {
  if (font.includes(',')) return font
  if (/\s/.test(font)) return `"${font}", sans-serif`
  return `${font}, sans-serif`
}

function determineTypographyScale(fingerprints: StyleFingerprint[]): 'sm' | 'md' | 'lg' {
  const tones = fingerprints.map(f => f.typographyTone)
  const editorial = tones.filter(t => t === 'editorial').length
  const minimal = tones.filter(t => t === 'minimal').length

  if (editorial > tones.length / 2) return 'lg'
  if (minimal > tones.length / 2) return 'sm'
  return 'md'
}

function determineSectionSpacing(sections: CanonicalSection[]): 'tight' | 'normal' | 'relaxed' {
  const spacings = sections.map(s => s.tokens.spacingY || 'md')
  const xlCount = spacings.filter(s => s === 'xl').length
  const smCount = spacings.filter(s => s === 'sm').length

  if (xlCount > spacings.length / 2) return 'relaxed'
  if (smCount > spacings.length / 2) return 'tight'
  return 'normal'
}

function majorityVote<T>(values: T[]): T {
  const counts = new Map<T, number>()
  for (const v of values) {
    counts.set(v, (counts.get(v) || 0) + 1)
  }
  let best: T = values[0]
  let bestCount = 0
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v
      bestCount = c
    }
  }
  return best
}

/**
 * strict モードの統一化を CanonicalSection 群に適用する。
 * 注意: セクションの構造は一切変更しない。
 * トークンレベルの統一のみ行う。
 */
export function applyStrictUnification(
  sections: CanonicalSection[],
  theme: PageTheme
): CanonicalSection[] {
  // strict では CanonicalSection 自体は変更しない。
  // テンプレート側で theme トークンを参照して統一を実現する。
  // ここでは constraints の確認のみ行う。
  return sections.map(section => ({
    ...section,
    constraints: {
      ...section.constraints,
      layoutLocked: true,  // strict では常に lock
      preserveOrder: true,
      preserveColumns: true,
      preserveBackground: true,
      preserveDensity: true,
    },
  }))
}
