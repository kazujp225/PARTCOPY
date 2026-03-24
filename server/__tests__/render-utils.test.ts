import { describe, expect, it } from 'vitest'
import { STORAGE_BUCKETS } from '../storage-config.js'
import {
  collectHtmlAssetUrls,
  parseStoredAssetUrl,
  rewriteCssAssetUrls,
  rewriteHtmlAssetUrls,
  scopeCss
} from '../render-utils.js'

function normalize(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

describe('scopeCss', () => {
  it('scopes selectors, renames keyframes, and extracts font faces', () => {
    const css = `
      body { margin: 0; }
      .button, .link:hover { color: red; }
      @media (min-width: 768px) {
        .button { padding: 24px; }
      }
      @font-face {
        font-family: TestFont;
        src: url("/assets/site/job/font.woff2");
      }
      @keyframes fade {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .hero { animation: fade 1s ease; }
    `

    const result = scopeCss(css, 'pc-sec-demo')
    const scopedCss = normalize(result.scopedCss)

    expect(scopedCss).toContain('.pc-sec-demo{ margin: 0; }')
    expect(scopedCss).toContain('.pc-sec-demo .button, .pc-sec-demo .link:hover{ color: red; }')
    expect(scopedCss).toContain('@media (min-width: 768px){ .pc-sec-demo .button{ padding: 24px; } }')
    expect(scopedCss).toContain('@keyframes pc-sec-demo-fade')
    expect(scopedCss).toContain('.pc-sec-demo .hero{ animation: pc-sec-demo-fade 1s ease; }')
    expect(scopedCss).not.toContain('@font-face')
    expect(result.fontFaceCss).toHaveLength(1)
    expect(normalize(result.fontFaceCss[0])).toContain('@font-face{ font-family: TestFont; src: url("/assets/site/job/font.woff2"); }')
  })
})

describe('rewriteCssAssetUrls', () => {
  it('rewrites relative css urls to local asset paths', () => {
    const css = `
      .hero { background-image: url("../images/hero.png"); }
      .icon { background-image: url("https://cdn.test.com/icon.svg"); }
      .inline { background-image: url("data:image/png;base64,abc"); }
    `

    const rewritten = normalize(rewriteCssAssetUrls(css, 'site/job/bundle.css'))

    expect(rewritten).toContain('url("/assets/site/job/../images/hero.png")')
    expect(rewritten).toContain('url("https://cdn.test.com/icon.svg")')
    expect(rewritten).toContain('url("data:image/png;base64,abc")')
  })
})

describe('html asset helpers', () => {
  it('collects and rewrites asset urls in html fragments', () => {
    const html = `
      <img src="https://cdn.test.com/logo.png" alt="logo">
      <source srcset="https://cdn.test.com/hero-1x.png 1x, https://cdn.test.com/hero-2x.png 2x">
      <div style="background-image: url(/assets/site/job/bg.jpg)"></div>
    `

    expect(collectHtmlAssetUrls(html)).toEqual([
      'https://cdn.test.com/logo.png',
      'https://cdn.test.com/hero-1x.png',
      'https://cdn.test.com/hero-2x.png',
      '/assets/site/job/bg.jpg'
    ])

    const rewritten = rewriteHtmlAssetUrls(html, (url) => {
      const map: Record<string, string> = {
        'https://cdn.test.com/logo.png': '/assets/logo-local.png',
        'https://cdn.test.com/hero-1x.png': '/assets/hero-local-1x.png',
        'https://cdn.test.com/hero-2x.png': '/assets/hero-local-2x.png',
        '/assets/site/job/bg.jpg': '/assets/bg-local.jpg'
      }
      return map[url]
    })

    expect(rewritten).toContain('src="/assets/logo-local.png"')
    expect(rewritten).toContain('srcset="/assets/hero-local-1x.png 1x, /assets/hero-local-2x.png 2x"')
    expect(rewritten).toContain('background-image: url(/assets/bg-local.jpg)')
  })
})

describe('parseStoredAssetUrl', () => {
  it('parses local asset urls', () => {
    expect(parseStoredAssetUrl('/assets/site/job/logo.png')).toEqual({
      bucket: STORAGE_BUCKETS.RAW_HTML,
      storagePath: 'site/job/logo.png'
    })
  })

  it('parses supabase signed asset urls', () => {
    expect(
      parseStoredAssetUrl('https://example.supabase.co/storage/v1/object/sign/corpus-raw-html/site%2Fjob%2Flogo.png?token=test')
    ).toEqual({
      bucket: 'corpus-raw-html',
      storagePath: 'site/job/logo.png'
    })
  })
})
