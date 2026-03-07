/**
 * Style Extractor
 * Extract computed style summary from sections.
 * Build layout signatures for dedup/similarity.
 * Create self-contained HTML documents for section preview.
 */
import type { DetectedSection } from './section-detector.js'
import crypto from 'crypto'

export interface StyleSummary {
  bgColor: string
  bgImage: string
  textColor: string
  fontSize: string
  fontFamily: string
  textAlign: string
  display: string
  padding: string
}

export function extractStyleSummary(section: DetectedSection): StyleSummary {
  const cs = section.computedStyles
  return {
    bgColor: cs.backgroundColor,
    bgImage: cs.backgroundImage,
    textColor: cs.color,
    fontSize: cs.fontSize,
    fontFamily: cs.fontFamily,
    textAlign: cs.textAlign,
    display: cs.display,
    padding: cs.padding
  }
}

/**
 * Generate a layout signature for dedup/similarity
 * Based on: tag structure, child count, heading count, button/form presence
 */
export function generateLayoutSignature(section: DetectedSection): string {
  const parts = [
    section.tagName.toLowerCase(),
    `h:${section.features.headingCount}`,
    `l:${section.features.linkCount}`,
    `b:${section.features.buttonCount}`,
    `f:${section.features.formCount}`,
    `i:${section.features.imageCount}`,
    `c:${section.features.cardCount}`,
    `ch:${section.features.childCount}`,
    `txt:${section.features.textLength > 500 ? 'long' : section.features.textLength > 100 ? 'mid' : 'short'}`,
    section.features.repeatedChildPattern || 'no-repeat'
  ]
  const raw = parts.join('|')
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 16)
}

/**
 * Build a self-contained HTML document for a section.
 * Uses <link> to reference the CSS bundle instead of inlining it (avoids 1.5MB per section).
 */
export function buildStandaloneHTML(
  sectionHTML: string,
  cssBundleUrl: string,
  pageOrigin: string,
  lang: string = 'ja'
): string {
  // Convert relative URLs in section HTML to absolute
  const absoluteHTML = sectionHTML
    .replace(
      /(src|href|srcset|poster|action)=(["'])(?!data:|https?:|\/\/|#|mailto:|tel:|javascript:)(\/?)([^"']*)\2/gi,
      (_, attr, q, slash, path) => `${attr}=${q}${pageOrigin}${slash ? '/' : '/'}${path}${q}`
    )

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="${pageOrigin}/">
<link rel="stylesheet" href="${cssBundleUrl}">
</head>
<body style="margin:0;padding:0">${absoluteHTML}</body>
</html>`
}
