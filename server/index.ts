import express from 'express'
import cors from 'cors'
import { extractParts } from './extractor.js'
import { saveParts, getAllParts, getPartsByGenre, getPartsByType, getGenres, deletePart, updatePartTags } from './storage.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))

// Extract parts from URL
app.post('/api/extract', async (req, res) => {
  const { url } = req.body
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'URL is required' })
    return
  }
  try {
    new URL(url)
  } catch {
    res.status(400).json({ error: 'Invalid URL format' })
    return
  }
  try {
    const parts = await extractParts(url)
    res.json({ parts })
  } catch (err: any) {
    console.error('Extraction error:', err)
    res.status(500).json({ error: err.message || 'Failed to extract parts' })
  }
})

// Save selected parts to library with genre/tags
app.post('/api/library/save', (req, res) => {
  const { parts, genre, tags } = req.body
  if (!parts || !Array.isArray(parts)) {
    res.status(400).json({ error: 'parts array is required' })
    return
  }
  const saved = saveParts(parts, genre || '', tags || [])
  res.json({ saved: saved.length })
})

// Get all saved parts (optionally filter by genre or type)
app.get('/api/library', (req, res) => {
  const { genre, type } = req.query
  if (genre && typeof genre === 'string') {
    res.json({ parts: getPartsByGenre(genre) })
  } else if (type && typeof type === 'string') {
    res.json({ parts: getPartsByType(type) })
  } else {
    res.json({ parts: getAllParts() })
  }
})

// Get all genres with counts
app.get('/api/library/genres', (_req, res) => {
  res.json({ genres: getGenres() })
})

// Update part genre/tags
app.patch('/api/library/:id', (req, res) => {
  const { genre, tags } = req.body
  const updated = updatePartTags(req.params.id, genre ?? '', tags ?? [])
  if (!updated) {
    res.status(404).json({ error: 'Part not found' })
    return
  }
  res.json({ part: updated })
})

// Delete part from library
app.delete('/api/library/:id', (req, res) => {
  const ok = deletePart(req.params.id)
  if (!ok) {
    res.status(404).json({ error: 'Part not found' })
    return
  }
  res.json({ deleted: true })
})

const PORT = 3001
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
