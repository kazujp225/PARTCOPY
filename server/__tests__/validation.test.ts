import { describe, expect, it } from 'vitest'

function validateExtract(body: Record<string, unknown>) {
  const { url, genre, tags } = body
  if (!url || typeof url !== 'string' || !/^https?:\/\/.+/.test(url)) {
    return { status: 400, body: { error: 'Valid URL (http/https) is required' } }
  }

  if (genre !== undefined && typeof genre !== 'string') {
    return { status: 400, body: { error: 'genre must be a string' } }
  }

  if (tags !== undefined) {
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
      return { status: 400, body: { error: 'tags must be an array of strings' } }
    }
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return { status: 400, body: { error: 'Invalid URL format' } }
  }

  return { status: 200, body: { ok: true, domain: parsedUrl.hostname } }
}

function validateSectionHtml(body: Record<string, unknown>) {
  const { html } = body
  if (typeof html !== 'string' || html.trim().length === 0) {
    return { status: 400, body: { error: 'html must be a non-empty string' } }
  }

  return { status: 200, body: { ok: true } }
}

describe('POST /api/extract validation', () => {
  it('returns 400 when url is missing', () => {
    const result = validateExtract({})
    expect(result.status).toBe(400)
    expect(result.body.error).toMatch(/URL/i)
  })

  it('returns 400 when url is not a string', () => {
    expect(validateExtract({ url: 12345 }).status).toBe(400)
  })

  it('returns 400 for non-http URL scheme', () => {
    expect(validateExtract({ url: 'ftp://example.com' }).status).toBe(400)
  })

  it('returns 400 for a bare string (not a URL)', () => {
    expect(validateExtract({ url: 'not-a-url' }).status).toBe(400)
  })

  it('passes validation for a valid http URL', () => {
    const result = validateExtract({ url: 'https://example.com' })
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
  })

  it('passes validation with optional genre and tags', () => {
    expect(validateExtract({ url: 'https://example.com', genre: 'saas', tags: ['startup'] }).status).toBe(200)
  })

  it('returns 400 when genre is not a string', () => {
    const result = validateExtract({ url: 'https://example.com', genre: 123 })
    expect(result.status).toBe(400)
    expect(result.body.error).toMatch(/genre/)
  })

  it('returns 400 when tags is not an array of strings', () => {
    const result = validateExtract({ url: 'https://example.com', tags: [1, 2] })
    expect(result.status).toBe(400)
    expect(result.body.error).toMatch(/tags/)
  })
})

describe('PUT /api/sections/:sectionId/html validation', () => {
  it('returns 400 when body has no html field', () => {
    const result = validateSectionHtml({})
    expect(result.status).toBe(400)
    expect(result.body.error).toMatch(/html/)
  })

  it('returns 400 when html is empty string', () => {
    expect(validateSectionHtml({ html: '   ' }).status).toBe(400)
  })

  it('returns 400 when html is not a string', () => {
    expect(validateSectionHtml({ html: 42 }).status).toBe(400)
  })

  it('passes validation when html is a non-empty string', () => {
    expect(validateSectionHtml({ html: '<div>Hello</div>' }).status).toBe(200)
  })
})
