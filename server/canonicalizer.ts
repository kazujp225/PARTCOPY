/**
 * Canonicalizer
 * Transform source_section → canonical block_instance
 * Extracts slots (headline, CTA, cards, etc.) and tokens (layout, spacing, tone)
 *
 * Phase 1: hero, feature, cta, faq, contact, footer の6種
 * Phase 2: StyleFingerprint + CanonicalSection 昇格サポート
 */
import * as cheerio from 'cheerio'
import type { DetectedSection } from './section-detector.js'
import type { StyleFingerprint, CanonicalSection, CanonicalConstraints, CanonicalContentSlot } from './canonical-types.js'
import { DEFAULT_STYLE_FINGERPRINT, DEFAULT_CONSTRAINTS, promoteToCanonicalSection } from './canonical-types.js'

export interface CanonicalSlots {
  [key: string]: any
}

export interface CanonicalTokens {
  alignment?: string
  bgTone?: string
  headingScale?: string
  spacingY?: string
  columns?: number
  iconStyle?: string
  [key: string]: any
}

export interface CanonicalBlock {
  family: string
  variant: string
  slots: CanonicalSlots
  tokens: CanonicalTokens
  qualityScore: number
}

// --- Slot extractors per family ---

function extractHeroSlots(section: DetectedSection): CanonicalSlots {
  const headings = section.features.headingTexts
  const text = section.textContent

  // Find CTA-like text
  const ctaPatterns = /(?:無料|資料|お問い合わせ|相談|申し込|始める|試す|ダウンロード|get started|sign up|try|contact|free)/gi
  const ctaMatches = text.match(ctaPatterns) || []

  return {
    headline: headings[0] || '',
    subheadline: headings[1] || '',
    primaryCta: ctaMatches[0] || '',
    secondaryCta: ctaMatches[1] || '',
    hasMedia: section.features.imageCount > 0,
    mediaCount: section.features.imageCount
  }
}

function extractFeatureSlots(section: DetectedSection): CanonicalSlots {
  const headings = section.features.headingTexts
  return {
    sectionTitle: headings[0] || '',
    itemCount: section.features.cardCount || section.features.childCount,
    hasIcons: section.features.hasSvg || section.features.imageCount > 0,
    repeatedPattern: section.features.repeatedChildPattern
  }
}

function extractCtaSlots(section: DetectedSection): CanonicalSlots {
  const headings = section.features.headingTexts
  const ctaPatterns = /(?:無料|資料|お問い合わせ|相談|申し込|始める|試す|ダウンロード|get started|sign up|contact)/gi
  const ctaMatches = section.textContent.match(ctaPatterns) || []

  return {
    headline: headings[0] || '',
    primaryCta: ctaMatches[0] || '',
    secondaryCta: ctaMatches[1] || '',
    buttonCount: section.features.buttonCount
  }
}

function extractFaqSlots(section: DetectedSection): CanonicalSlots {
  const headings = section.features.headingTexts
  return {
    sectionTitle: headings[0] || '',
    itemCount: section.features.listItemCount || section.features.childCount,
    hasAccordion: section.classTokens.some(c => /accordion|toggle|collapse|faq/i.test(c))
  }
}

function extractContactSlots(section: DetectedSection): CanonicalSlots {
  const headings = section.features.headingTexts
  return {
    headline: headings[0] || '',
    hasForm: section.features.formCount > 0,
    hasMap: section.classTokens.some(c => /map|gmap/i.test(c)),
    hasPhone: /(?:tel:|電話|TEL|phone)/i.test(section.textContent),
    hasEmail: /(?:mailto:|@|メール|email)/i.test(section.textContent)
  }
}

function extractFooterSlots(section: DetectedSection): CanonicalSlots {
  return {
    linkCount: section.features.linkCount,
    hasSocialLinks: section.classTokens.some(c => /social|sns|twitter|facebook|instagram|youtube|linkedin/i.test(c)),
    hasCopyright: /(?:©|copyright|\(c\)|all rights)/i.test(section.textContent),
    columnCount: Math.min(section.features.childCount, 6)
  }
}

function extractGenericSlots(section: DetectedSection): CanonicalSlots {
  return {
    headingTexts: section.features.headingTexts,
    textLength: section.features.textLength,
    hasImages: section.features.imageCount > 0,
    hasCTA: section.features.buttonCount > 0
  }
}

// --- Token extraction ---

function extractTokens(section: DetectedSection): CanonicalTokens {
  const cs = section.computedStyles
  const tokens: CanonicalTokens = {}

  // Alignment
  tokens.alignment = cs.textAlign === 'center' ? 'center'
    : cs.textAlign === 'right' ? 'right'
    : 'left'

  // Background tone
  const bg = cs.backgroundColor
  if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
    tokens.bgTone = 'transparent'
  } else if (/rgb\(\s*(\d+)/.test(bg)) {
    const r = parseInt(RegExp.$1)
    tokens.bgTone = r > 200 ? 'light' : r < 60 ? 'dark' : 'medium'
  } else {
    tokens.bgTone = 'light'
  }

  // Heading scale
  const fontSize = parseInt(cs.fontSize) || 16
  tokens.headingScale = fontSize >= 40 ? '2xl'
    : fontSize >= 32 ? 'xl'
    : fontSize >= 24 ? 'lg'
    : fontSize >= 18 ? 'md'
    : 'sm'

  // Spacing
  const padding = parseInt(cs.padding) || 0
  tokens.spacingY = padding >= 80 ? 'xl'
    : padding >= 48 ? 'lg'
    : padding >= 24 ? 'md'
    : 'sm'

  return tokens
}

// --- Variant detection ---

function detectHeroVariant(section: DetectedSection): string {
  const { imageCount, buttonCount } = section.features
  const hasGrid = section.classTokens.some(c => /grid|flex|split|col/i.test(c))

  if (imageCount > 3) return 'hero_with_trust'
  if (hasGrid && imageCount > 0) return 'hero_split_left'
  return 'hero_centered'
}

function detectFeatureVariant(section: DetectedSection): string {
  const cardCount = section.features.cardCount || section.features.childCount
  if (cardCount >= 6) return 'feature_grid_6'
  if (cardCount >= 4) return 'feature_grid_4'
  if (cardCount >= 3) return 'feature_grid_3'
  return 'feature_alternating'
}

function detectCtaVariant(section: DetectedSection): string {
  return section.features.buttonCount >= 2 ? 'cta_banner_dual' : 'cta_banner_single'
}

function detectFaqVariant(section: DetectedSection): string {
  const hasAccordion = section.classTokens.some(c => /accordion|toggle|collapse/i.test(c))
  return hasAccordion ? 'faq_accordion' : 'faq_2col'
}

function detectContactVariant(section: DetectedSection): string {
  const hasForm = section.features.formCount > 0
  const hasInfo = /(?:tel:|電話|TEL|住所|address|〒)/i.test(section.textContent)
  return hasForm && hasInfo ? 'contact_split' : 'contact_form_full'
}

function detectFooterVariant(section: DetectedSection): string {
  return section.features.linkCount > 10 ? 'footer_sitemap' : 'footer_minimal'
}

// --- Main canonicalize function ---

export function canonicalizeSection(
  section: DetectedSection,
  classifiedFamily: string
): CanonicalBlock | null {
  let slots: CanonicalSlots
  let variant: string

  switch (classifiedFamily) {
    case 'hero':
      slots = extractHeroSlots(section)
      variant = detectHeroVariant(section)
      break
    case 'feature':
      slots = extractFeatureSlots(section)
      variant = detectFeatureVariant(section)
      break
    case 'cta':
      slots = extractCtaSlots(section)
      variant = detectCtaVariant(section)
      break
    case 'faq':
      slots = extractFaqSlots(section)
      variant = detectFaqVariant(section)
      break
    case 'contact':
      slots = extractContactSlots(section)
      variant = detectContactVariant(section)
      break
    case 'footer':
      slots = extractFooterSlots(section)
      variant = detectFooterVariant(section)
      break
    case 'navigation':
      slots = { linkCount: section.features.linkCount, hasCTA: section.features.buttonCount > 0 }
      variant = section.features.linkCount > 8 ? 'nav_mega' : 'nav_simple'
      break
    case 'pricing':
      slots = { sectionTitle: section.features.headingTexts[0] || '', planCount: section.features.cardCount }
      variant = section.classTokens.some(c => /toggle|switch/i.test(c)) ? 'pricing_toggle' : 'pricing_3col'
      break
    case 'social_proof':
      slots = { sectionTitle: section.features.headingTexts[0] || '', itemCount: section.features.cardCount }
      variant = section.features.imageCount > section.features.cardCount ? 'logo_strip' : 'testimonial_cards'
      break
    case 'stats':
      slots = { stats: section.features.cardCount || section.features.childCount }
      variant = section.features.headingTexts.length > 0 ? 'stats_with_text' : 'stats_row'
      break
    default:
      slots = extractGenericSlots(section)
      variant = `${classifiedFamily}_default`
      break
  }

  const tokens = extractTokens(section)

  // Quality score: higher confidence + richer slots = better
  const slotFillRate = Object.values(slots).filter(v => v !== '' && v !== null && v !== false && v !== 0).length / Math.max(Object.keys(slots).length, 1)
  const qualityScore = Math.round(slotFillRate * 100) / 100

  return {
    family: classifiedFamily,
    variant,
    slots,
    tokens,
    qualityScore
  }
}

// ============================================================
// StyleFingerprint extraction (CSS テキストから判定)
// ============================================================

export function extractStyleFingerprint(css: string, html?: string): StyleFingerprint {
  if (!css || css.length < 20) return { ...DEFAULT_STYLE_FINGERPRINT }

  // Color density: count unique colors
  const colorMatches = css.match(/#[0-9a-fA-F]{3,8}|rgb\([^)]+\)|hsl\([^)]+\)/g) || []
  const uniqueColors = new Set(colorMatches).size
  const colorDensity: StyleFingerprint['colorDensity'] =
    uniqueColors >= 12 ? 'high' : uniqueColors >= 5 ? 'mid' : 'low'

  // Typography tone
  const hasSerif = /serif/i.test(css) && !/sans-serif/i.test(css)
  const hasPlayful = /comic|marker|handwrit|cursive|fantasy/i.test(css)
  const hasEditorial = hasSerif || /letter-spacing|text-transform.*uppercase/i.test(css)
  const typographyTone: StyleFingerprint['typographyTone'] =
    hasPlayful ? 'playful'
    : hasEditorial ? 'editorial'
    : /font-weight:\s*(700|800|900|bold)/i.test(css) ? 'corporate'
    : 'minimal'

  // Corner style
  const radiusMatches = css.match(/border-radius:\s*([0-9.]+)(px|rem|em|%)/gi) || []
  let avgRadius = 0
  if (radiusMatches.length > 0) {
    const values = radiusMatches.map(m => {
      const n = parseFloat(m.replace(/border-radius:\s*/i, ''))
      return isNaN(n) ? 0 : n
    })
    avgRadius = values.reduce((a, b) => a + b, 0) / values.length
  }
  const cornerStyle: StyleFingerprint['cornerStyle'] =
    avgRadius >= 20 ? 'pill' : avgRadius >= 4 ? 'soft' : 'sharp'

  // Shadow level
  const shadowCount = (css.match(/box-shadow/gi) || []).length
  const shadowLevel: StyleFingerprint['shadowLevel'] =
    shadowCount >= 6 ? 3 : shadowCount >= 3 ? 2 : shadowCount >= 1 ? 1 : 0

  // Background type
  const hasGradient = /linear-gradient|radial-gradient/i.test(css)
  const hasBgImage = /background-image:\s*url/i.test(css)
  const hasBgColor = /background(-color)?:\s*#[0-9a-f]/i.test(css)
  const backgroundType: StyleFingerprint['backgroundType'] =
    hasGradient ? 'gradient'
    : hasBgImage ? 'image'
    : hasBgColor ? 'tint'
    : 'plain'

  return { colorDensity, typographyTone, cornerStyle, shadowLevel, backgroundType }
}

// ============================================================
// HTML → DetectedSection features extraction (cheerio ベース)
// ============================================================

/**
 * prepared.html から DetectedSection 互換の features と classTokens を抽出する。
 * server/index.ts の export/canonicalize で minimalSection を埋めるために使う。
 */
export function extractFeaturesFromHtml(html: string, textSummary?: string): {
  features: DetectedSection['features']
  classTokens: string[]
  textContent: string
  computedStyles: DetectedSection['computedStyles']
} {
  const $ = cheerio.load(html || '')

  // Heading texts
  const headingTexts: string[] = []
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim()
    if (text && text.length < 200) headingTexts.push(text)
  })

  // Counts
  const imageCount = $('img, picture, svg.hero-img, [role="img"]').length
  const buttonCount = $('button, input[type="submit"], input[type="button"], a[class*="btn"], a[class*="button"], a[class*="cta"]').length
  const linkCount = $('a').length
  const formCount = $('form').length
  const listItemCount = $('li').length
  const hasSvg = $('svg').length > 0

  // Card-like items (common repeated structures)
  const cardSelectors = [
    '[class*="card"]', '[class*="item"]', '[class*="col-"]',
    '.grid > div', '.flex > div', '[class*="feature"]',
    '[class*="plan"]', '[class*="price"]', '[class*="testimonial"]'
  ]
  let cardCount = 0
  for (const sel of cardSelectors) {
    const count = $(sel).length
    if (count >= 2) {
      cardCount = Math.max(cardCount, count)
      break
    }
  }

  // Child count (direct children of root)
  const root = $.root().children().first()
  const childCount = root.children().length

  // Text content
  const textContent = textSummary || $.text().replace(/\s+/g, ' ').trim().slice(0, 1000)

  // Class tokens (from root and direct children)
  const classTokens: string[] = []
  const collectClasses = (el: any) => {
    const cls = $(el).attr('class')
    if (cls) {
      classTokens.push(...cls.split(/\s+/).filter(Boolean))
    }
  }
  root.find('*').slice(0, 30).each((_, el) => collectClasses(el))
  collectClasses(root)

  // Repeated child pattern
  let repeatedChildPattern = false
  if (childCount >= 3) {
    const tagNames = root.children().toArray().map(el => $(el).prop('tagName')?.toLowerCase())
    const firstTag = tagNames[0]
    if (firstTag && tagNames.filter(t => t === firstTag).length >= tagNames.length * 0.7) {
      repeatedChildPattern = true
    }
  }

  // Pseudo computedStyles from CSS class hints
  const allClasses = classTokens.join(' ')
  const textAlign = /text-center|text-align.*center|mx-auto/i.test(allClasses) ? 'center'
    : /text-right/i.test(allClasses) ? 'right' : 'left'
  const hasDarkBg = /bg-dark|bg-black|bg-gray-9|bg-slate-9|dark/i.test(allClasses)
  const backgroundColor = hasDarkBg ? 'rgb(30, 30, 30)' : 'transparent'

  return {
    features: {
      headingTexts,
      imageCount,
      buttonCount,
      linkCount,
      formCount,
      listItemCount,
      cardCount,
      childCount,
      textLength: textContent.length,
      hasSvg,
      repeatedChildPattern,
    } as any,
    classTokens,
    textContent,
    computedStyles: {
      textAlign,
      backgroundColor,
      fontSize: '16px',
      padding: '0',
    } as any,
  }
}

// ============================================================
// Layout type detection (family/variant → canonical layoutType)
// ============================================================

/** family default template mapping (fallback 用) */
const FAMILY_DEFAULT_LAYOUT: Record<string, string> = {
  hero: 'hero/centered-copy',
  feature: 'feature/grid-3',
  cta: 'cta/centered',
  faq: 'faq/accordion',
  contact: 'contact/form-full',
  footer: 'footer/multi-column',
  navigation: 'navigation/simple',
  pricing: 'pricing/three-cards',
  social_proof: 'social-proof/testimonial-cards',
  stats: 'stats/row',
  content: 'content/default',
  recruit: 'recruit/default',
  news_list: 'news-list/default',
  timeline: 'timeline/default',
  company_profile: 'company-profile/default',
  gallery: 'gallery/default',
  logo_cloud: 'logo-cloud/default',
}

/** variant → layoutType マッピング */
const VARIANT_TO_LAYOUT: Record<string, string> = {
  hero_centered: 'hero/centered-copy',
  hero_split_left: 'hero/split-media',
  hero_with_trust: 'hero/with-trust-bar',
  feature_grid_3: 'feature/grid-3',
  feature_grid_4: 'feature/grid-4',
  feature_grid_6: 'feature/grid-6',
  feature_alternating: 'feature/alternating',
  cta_banner_single: 'cta/centered',
  cta_banner_dual: 'cta/dual-button',
  faq_accordion: 'faq/accordion',
  faq_2col: 'faq/two-column',
  contact_form_full: 'contact/form-full',
  contact_split: 'contact/split',
  footer_sitemap: 'footer/multi-column',
  footer_minimal: 'footer/minimal',
  nav_simple: 'navigation/simple',
  nav_mega: 'navigation/mega',
  pricing_3col: 'pricing/three-cards',
  pricing_toggle: 'pricing/toggle',
  logo_strip: 'social-proof/logo-strip',
  testimonial_cards: 'social-proof/testimonial-cards',
  stats_row: 'stats/row',
  stats_with_text: 'stats/with-text',
}

function resolveLayoutType(family: string, variant: string): string {
  return VARIANT_TO_LAYOUT[variant] || FAMILY_DEFAULT_LAYOUT[family] || `${family}/default`
}

// ============================================================
// Full canonicalization: CanonicalBlock → CanonicalSection
// ============================================================

/**
 * 完全な正規化を一発で行う。
 * CanonicalBlock を内部で生成し、CanonicalSection に昇格して返す。
 */
export function canonicalizeSectionFull(
  section: DetectedSection,
  classifiedFamily: string,
  extras: {
    sectionId: string
    css?: string
    screenshotPath?: string
    sourceUrl?: string
    sourceDomain?: string
    constraintOverrides?: Partial<CanonicalConstraints>
  }
): CanonicalSection | null {
  const block = canonicalizeSection(section, classifiedFamily)
  if (!block) return null

  const layoutType = resolveLayoutType(block.family, block.variant)
  const fingerprint = extras.css ? extractStyleFingerprint(extras.css) : undefined

  const canonical = promoteToCanonicalSection(block, {
    id: `cs-${extras.sectionId}`,
    rawSectionId: extras.sectionId,
    screenshotPath: extras.screenshotPath,
    sourceUrl: extras.sourceUrl,
    sourceDomain: extras.sourceDomain,
    styleFingerprint: fingerprint,
    constraints: extras.constraintOverrides,
  })

  // Override layoutType with resolved one
  canonical.layoutType = layoutType

  return canonical
}

// Re-export for external use
export { FAMILY_DEFAULT_LAYOUT, VARIANT_TO_LAYOUT, resolveLayoutType }
