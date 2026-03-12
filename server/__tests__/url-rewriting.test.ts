import { describe, it, expect } from 'vitest'

/**
 * Test the URL rewriting logic used in worker.ts (rewriteStoredHtml).
 * The function does a simple split/join replacement for each entry,
 * processing entries sorted by URL length (longest first) to avoid
 * partial-match issues.
 */
function rewriteStoredHtml(
  html: string,
  sortedEntries: Array<[string, string]>
): string {
  let result = html
  for (const [originalUrl, localPath] of sortedEntries) {
    result = result.split(originalUrl).join(localPath)
  }
  return result
}

/** Helper: sort entries by URL length descending (as worker.ts does) */
function sortByLength(entries: Array<[string, string]>): Array<[string, string]> {
  return [...entries].sort((a, b) => b[0].length - a[0].length)
}

describe('rewriteStoredHtml', () => {
  it('replaces original URLs with local paths', () => {
    const html = '<img src="https://example.com/img/hero.png">'
    const entries: Array<[string, string]> = [
      ['https://example.com/img/hero.png', '/assets/site1/job1/img/hero.png']
    ]

    const result = rewriteStoredHtml(html, sortByLength(entries))
    expect(result).toBe('<img src="/assets/site1/job1/img/hero.png">')
  })

  it('replaces multiple occurrences of the same URL', () => {
    const html = `
      <img src="https://cdn.test.com/a.jpg">
      <div style="background: url(https://cdn.test.com/a.jpg)">
    `
    const entries: Array<[string, string]> = [
      ['https://cdn.test.com/a.jpg', '/assets/s/j/a.jpg']
    ]

    const result = rewriteStoredHtml(html, sortByLength(entries))
    expect(result).not.toContain('https://cdn.test.com/a.jpg')
    expect(result.match(/\/assets\/s\/j\/a\.jpg/g)?.length).toBe(2)
  })

  it('replaces longer URLs first to avoid partial match corruption', () => {
    const html = `
      <link href="https://example.com/css/main.css">
      <link href="https://example.com/css/main.css?v=2">
    `
    const entries: Array<[string, string]> = [
      ['https://example.com/css/main.css', '/assets/s/j/main.css'],
      ['https://example.com/css/main.css?v=2', '/assets/s/j/main-v2.css']
    ]

    const result = rewriteStoredHtml(html, sortByLength(entries))
    // The versioned URL (longer) should be replaced first, preserving the shorter one
    expect(result).toContain('/assets/s/j/main-v2.css')
    expect(result).toContain('/assets/s/j/main.css')
    // Verify the versioned one was NOT corrupted into "/assets/s/j/main.css?v=2"
    expect(result).not.toContain('/assets/s/j/main.css?v=2')
  })

  it('handles empty entries array (no replacements)', () => {
    const html = '<div>hello</div>'
    const result = rewriteStoredHtml(html, [])
    expect(result).toBe('<div>hello</div>')
  })

  it('handles HTML with no matching URLs', () => {
    const html = '<p>No URLs here</p>'
    const entries: Array<[string, string]> = [
      ['https://nomatch.com/x.js', '/assets/x.js']
    ]
    const result = rewriteStoredHtml(html, sortByLength(entries))
    expect(result).toBe('<p>No URLs here</p>')
  })

  it('handles URLs appearing in different attribute contexts', () => {
    const html = `
      <script src="https://cdn.com/app.js"></script>
      <link rel="stylesheet" href="https://cdn.com/style.css">
      <img src="https://cdn.com/logo.svg" alt="Logo">
    `
    const entries: Array<[string, string]> = [
      ['https://cdn.com/app.js', '/assets/s/j/app.js'],
      ['https://cdn.com/style.css', '/assets/s/j/style.css'],
      ['https://cdn.com/logo.svg', '/assets/s/j/logo.svg']
    ]

    const result = rewriteStoredHtml(html, sortByLength(entries))
    expect(result).toContain('/assets/s/j/app.js')
    expect(result).toContain('/assets/s/j/style.css')
    expect(result).toContain('/assets/s/j/logo.svg')
    expect(result).not.toContain('https://cdn.com/')
  })
})
