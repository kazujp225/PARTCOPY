import { describe, expect, it } from 'vitest'
import {
  BLOCK_FAMILY_LABELS,
  buildClaudeInstructions,
  buildComponentName,
  buildSectionSpec,
  buildSectionSpecsMarkdown
} from '../export-instructions.js'

describe('buildComponentName', () => {
  it('creates stable unique component names by family', () => {
    const usedNames = new Set<string>()

    expect(buildComponentName('hero', 1, usedNames)).toBe('HeroSection')
    expect(buildComponentName('hero', 2, usedNames)).toBe('HeroSection2')
    expect(buildComponentName('social_proof', 3, usedNames)).toBe('SocialProofSection')
  })
})

describe('buildSectionSpec', () => {
  it('extracts layout cues and text samples from html', () => {
    const spec = buildSectionSpec({
      index: 1,
      sectionId: 'sec-1',
      blockFamily: 'hero',
      componentName: 'HeroSection',
      domain: 'example.com',
      sourceUrl: 'https://example.com',
      screenshotFile: '01-hero.png',
      textSummary: 'AI導入支援サービスのヒーローセクション',
      css: '.hero { background-image: linear-gradient(#111, #333); }',
      html: `
        <section>
          <h1>AIで営業を加速する</h1>
          <p>最短2週間で導入できる営業支援プラットフォームです。</p>
          <a href="/contact">無料相談</a>
          <button>資料請求</button>
          <img src="/hero.png" alt="hero">
        </section>
      `
    })

    expect(spec.blockFamilyLabel).toBe(BLOCK_FAMILY_LABELS.hero)
    expect(spec.layout.headings).toBe(1)
    expect(spec.layout.images).toBe(1)
    expect(spec.ctaLabels).toEqual(['無料相談', '資料請求'])
    expect(spec.headingSamples[0]).toContain('AIで営業を加速する')
    expect(spec.recreationNotes.join(' ')).toMatch(/背景表現/)
  })
})

describe('instruction builders', () => {
  it('generates markdown and claude instructions from specs', () => {
    const spec = buildSectionSpec({
      index: 1,
      sectionId: 'sec-1',
      blockFamily: 'cta',
      componentName: 'CtaSection',
      domain: 'example.com',
      sourceUrl: 'https://example.com/cta',
      screenshotFile: '01-cta.png',
      textSummary: '問い合わせ促進用のCTA',
      html: '<section><h2>今すぐ始める</h2><a href="/signup">無料で試す</a></section>'
    })

    const markdown = buildSectionSpecsMarkdown([spec])
    const claude = buildClaudeInstructions({
      projectName: 'Example Project',
      companyName: 'Example Inc.',
      serviceDescription: 'AI SaaS',
      specs: [spec]
    })

    expect(markdown).toContain('screenshots/01-cta.png')
    expect(markdown).toContain('CTA候補')
    expect(claude).toContain('Example Project')
    expect(claude).toContain('src/components/')
    expect(claude).toContain('specs/sections.json')
  })
})
