/**
 * Canonical Types for PARTCOPY Normalization Pipeline
 *
 * CanonicalBlock (既存) を土台に、export/統一化用の拡張型を追加。
 * 既存の CanonicalBlock は内部表現としてそのまま活かし、
 * CanonicalSection は export/新機能向けの拡張ビューとして利用する。
 */

import type { CanonicalBlock, CanonicalSlots, CanonicalTokens } from './canonicalizer.js'

// ============================================================
// Unify Mode
// ============================================================
export type UnifyMode = 'strict' | 'balanced' | 'rebuild'

// ============================================================
// Content Slots (export 向け正規化表現)
// ============================================================
export interface CanonicalContentSlot {
  key: string
  kind: 'heading' | 'text' | 'image' | 'button' | 'list' | 'form' | 'badge' | 'stat'
  value?: string
  meta?: Record<string, string | number | boolean>
}

// ============================================================
// Constraints (layout lock 等)
// ============================================================
export interface CanonicalConstraints {
  layoutLocked: boolean
  preserveOrder: boolean
  preserveColumns: boolean
  preserveBackground: boolean
  preserveDensity: boolean
}

export const DEFAULT_CONSTRAINTS: CanonicalConstraints = {
  layoutLocked: true,
  preserveOrder: true,
  preserveColumns: true,
  preserveBackground: true,
  preserveDensity: true,
}

// ============================================================
// Style Fingerprint
// ============================================================
export interface StyleFingerprint {
  colorDensity: 'low' | 'mid' | 'high'
  typographyTone: 'minimal' | 'corporate' | 'editorial' | 'playful'
  cornerStyle: 'sharp' | 'soft' | 'pill'
  shadowLevel: 0 | 1 | 2 | 3
  backgroundType: 'plain' | 'tint' | 'image' | 'gradient'
}

export const DEFAULT_STYLE_FINGERPRINT: StyleFingerprint = {
  colorDensity: 'mid',
  typographyTone: 'corporate',
  cornerStyle: 'soft',
  shadowLevel: 1,
  backgroundType: 'plain',
}

// ============================================================
// CanonicalSection (CanonicalBlock の拡張ビュー)
// ============================================================
export interface CanonicalSection {
  id: string
  rawSectionId: string
  family: string
  variant: string
  layoutType: string
  structureSignature: string

  // 既存 CanonicalBlock から引き継ぎ
  slots: CanonicalSlots
  tokens: CanonicalTokens
  qualityScore: number

  // 新規拡張
  contentSlots: CanonicalContentSlot[]
  styleFingerprint: StyleFingerprint
  constraints: CanonicalConstraints
  references: {
    screenshotPath: string
    sourceUrl: string
    sourceDomain: string
  }
}

// ============================================================
// Page Theme (統一化トークン)
// ============================================================
export interface PageTheme {
  mode: UnifyMode
  colorTokens: Record<string, string>
  typography: {
    bodyFont: string
    headingFont: string
    scale: 'sm' | 'md' | 'lg'
  }
  spacing: {
    sectionY: 'tight' | 'normal' | 'relaxed'
    containerWidth: 'xl' | '2xl' | '3xl'
  }
  buttonStyle: {
    radius: 'md' | 'lg' | 'xl' | 'full'
    weight: 'solid' | 'soft' | 'outline'
  }
}

export const DEFAULT_PAGE_THEME: PageTheme = {
  mode: 'strict',
  colorTokens: {
    primary: '#3b82f6',
    'primary-foreground': '#ffffff',
    secondary: '#64748b',
    accent: '#f59e0b',
    background: '#ffffff',
    foreground: '#0f172a',
    muted: '#f1f5f9',
    border: '#e2e8f0',
  },
  typography: {
    bodyFont: '"Noto Sans JP", "Hiragino Sans", sans-serif',
    headingFont: '"Noto Sans JP", "Hiragino Sans", sans-serif',
    scale: 'md',
  },
  spacing: {
    sectionY: 'normal',
    containerWidth: '2xl',
  },
  buttonStyle: {
    radius: 'lg',
    weight: 'solid',
  },
}

// ============================================================
// Canvas Page (将来の multi-page 対応含む)
// ============================================================
export interface CanvasPage {
  id: string
  name: string
  sectionIds: string[]
  unifyMode: UnifyMode
  theme?: PageTheme
}

// ============================================================
// CanonicalBlock → CanonicalSection 変換ヘルパー
// ============================================================

/**
 * 既存の CanonicalBlock を CanonicalSection に昇格させる。
 * 足りない情報は defaults + 引数で補完する。
 */
export function promoteToCanonicalSection(
  block: CanonicalBlock,
  extras: {
    id: string
    rawSectionId: string
    screenshotPath?: string
    sourceUrl?: string
    sourceDomain?: string
    contentSlots?: CanonicalContentSlot[]
    styleFingerprint?: Partial<StyleFingerprint>
    constraints?: Partial<CanonicalConstraints>
  }
): CanonicalSection {
  const layoutType = `${block.family}/${block.variant}`

  // structureSignature: family + variant + slot keys のハッシュ的文字列
  const slotKeys = Object.keys(block.slots).sort().join(',')
  const structureSignature = `${block.family}:${block.variant}:${slotKeys}`

  return {
    id: extras.id,
    rawSectionId: extras.rawSectionId,
    family: block.family,
    variant: block.variant,
    layoutType,
    structureSignature,

    // 既存データ引き継ぎ
    slots: block.slots,
    tokens: block.tokens,
    qualityScore: block.qualityScore,

    // 新規拡張
    contentSlots: extras.contentSlots || slotsToContentSlots(block.family, block.slots),
    styleFingerprint: { ...DEFAULT_STYLE_FINGERPRINT, ...extras.styleFingerprint },
    constraints: { ...DEFAULT_CONSTRAINTS, ...extras.constraints },
    references: {
      screenshotPath: extras.screenshotPath || '',
      sourceUrl: extras.sourceUrl || '',
      sourceDomain: extras.sourceDomain || '',
    },
  }
}

/**
 * 既存 CanonicalSlots → CanonicalContentSlot[] への薄い互換変換。
 * family ごとにスロットの意味が分かっているので、適切な kind を割り当てる。
 */
function slotsToContentSlots(family: string, slots: CanonicalSlots): CanonicalContentSlot[] {
  const result: CanonicalContentSlot[] = []

  // 共通パターン: headline → heading
  if (slots.headline) {
    result.push({ key: 'headline', kind: 'heading', value: slots.headline })
  }
  if (slots.subheadline) {
    result.push({ key: 'subheadline', kind: 'text', value: slots.subheadline })
  }
  if (slots.sectionTitle) {
    result.push({ key: 'sectionTitle', kind: 'heading', value: slots.sectionTitle })
  }

  // CTA
  if (slots.primaryCta) {
    result.push({ key: 'primaryCta', kind: 'button', value: slots.primaryCta })
  }
  if (slots.secondaryCta) {
    result.push({ key: 'secondaryCta', kind: 'button', value: slots.secondaryCta })
  }

  // Media
  if (slots.hasMedia || slots.hasImages) {
    result.push({ key: 'media', kind: 'image', meta: { count: slots.mediaCount || 0 } })
  }

  // Form
  if (slots.hasForm) {
    result.push({ key: 'form', kind: 'form' })
  }

  // Items (feature cards, FAQ items, etc.)
  if (slots.itemCount && slots.itemCount > 0) {
    result.push({ key: 'items', kind: 'list', meta: { count: slots.itemCount } })
  }

  // Stats
  if (slots.stats) {
    result.push({ key: 'stats', kind: 'stat', meta: { count: slots.stats } })
  }

  // Generic headings fallback
  if (result.length === 0 && slots.headingTexts?.length > 0) {
    for (const [i, text] of slots.headingTexts.entries()) {
      result.push({ key: `heading_${i}`, kind: 'heading', value: text })
    }
  }

  return result
}
