/**
 * Canonicalizer
 * Transform source_section → canonical block_instance
 * Extracts slots (headline, CTA, cards, etc.) and tokens (layout, spacing, tone)
 *
 * Phase 1: hero, feature, cta, faq, contact, footer の6種
 */
import type { DetectedSection } from './section-detector.js'

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
