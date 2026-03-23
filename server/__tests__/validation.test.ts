import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { Server } from 'http'

/**
 * Test API validation logic by spinning up a minimal Express app
 * that mirrors the validation from server/index.ts, without
 * requiring Supabase or other infrastructure.
 */

let server: Server
let baseUrl: string

beforeAll(async () => {
  const app = express()
  app.use(express.json({ limit: '1mb' }))

  // Mirror the POST /api/extract validation from server/index.ts
  app.post('/api/extract', (req, res) => {
    const { url, genre, tags } = req.body
    if (!url || typeof url !== 'string' || !/^https?:\/\/.+/.test(url)) {
      res.status(400).json({ error: 'Valid URL (http/https) is required' })
      return
    }

    if (genre !== undefined && typeof genre !== 'string') {
      res.status(400).json({ error: 'genre must be a string' })
      return
    }

    if (tags !== undefined) {
      if (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === 'string')) {
        res.status(400).json({ error: 'tags must be an array of strings' })
        return
      }
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      res.status(400).json({ error: 'Invalid URL format' })
      return
    }

    // If validation passes, return 200 (real server would create a job)
    res.json({ ok: true, domain: parsedUrl.hostname })
  })

  // Mirror the PUT /api/sections/:sectionId/html validation
  app.put('/api/sections/:sectionId/html', (req, res) => {
    const { html } = req.body
    if (typeof html !== 'string' || html.trim().length === 0) {
      res.status(400).json({ error: 'html must be a non-empty string' })
      return
    }
    // If validation passes, return 200
    res.json({ ok: true })
  })

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`
      }
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
})

describe('POST /api/extract validation', () => {
  it('returns 400 when url is missing', async () => {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/URL/i)
  })

  it('returns 400 when url is not a string', async () => {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 12345 })
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for non-http URL scheme', async () => {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'ftp://example.com' })
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for a bare string (not a URL)', async () => {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not-a-url' })
    })
    expect(res.status).toBe(400)
  })

  it('passes validation for a valid http URL', async () => {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' })
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
  })

  it('passes validation with optional genre and tags', async () => {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', genre: 'saas', tags: ['startup'] })
    })
    expect(res.status).toBe(200)
  })

  it('returns 400 when genre is not a string', async () => {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', genre: 123 })
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/genre/)
  })

  it('returns 400 when tags is not an array of strings', async () => {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', tags: [1, 2] })
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/tags/)
  })
})

describe('PUT /api/sections/:sectionId/html validation', () => {
  it('returns 400 when body has no html field', async () => {
    const res = await fetch(`${baseUrl}/api/sections/fake-id/html`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/html/)
  })

  it('returns 400 when html is empty string', async () => {
    const res = await fetch(`${baseUrl}/api/sections/fake-id/html`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '   ' })
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when html is not a string', async () => {
    const res = await fetch(`${baseUrl}/api/sections/fake-id/html`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: 42 })
    })
    expect(res.status).toBe(400)
  })

  it('passes validation when html is a non-empty string', async () => {
    const res = await fetch(`${baseUrl}/api/sections/fake-id/html`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<div>Hello</div>' })
    })
    expect(res.status).toBe(200)
  })
})
