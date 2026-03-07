import fs from 'fs'
import path from 'path'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data')
const PARTS_FILE = path.join(DATA_DIR, 'parts.json')

interface StoredPart {
  id: string
  type: string
  confidence: number
  html: string
  textContent: string
  tagName: string
  thumbnail?: string
  genre: string
  tags: string[]
  meta: Record<string, any>
  sourceUrl: string
  savedAt: string
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

function readAll(): StoredPart[] {
  ensureDir()
  if (!fs.existsSync(PARTS_FILE)) return []
  const raw = fs.readFileSync(PARTS_FILE, 'utf-8')
  try {
    return JSON.parse(raw)
  } catch {
    return []
  }
}

function writeAll(parts: StoredPart[]) {
  ensureDir()
  fs.writeFileSync(PARTS_FILE, JSON.stringify(parts, null, 2), 'utf-8')
}

export function saveParts(parts: any[], genre: string, tags: string[]): StoredPart[] {
  const existing = readAll()
  const now = new Date().toISOString()
  const newParts: StoredPart[] = parts.map(p => ({
    id: p.id,
    type: p.type,
    confidence: p.confidence,
    html: p.html,
    textContent: p.textContent,
    tagName: p.tagName,
    thumbnail: p.thumbnail,
    genre,
    tags,
    meta: p.meta,
    sourceUrl: p.sourceUrl,
    savedAt: now
  }))
  const merged = [...existing, ...newParts]
  writeAll(merged)
  return newParts
}

export function getAllParts(): StoredPart[] {
  return readAll()
}

export function getPartsByGenre(genre: string): StoredPart[] {
  return readAll().filter(p => p.genre === genre)
}

export function getPartsByType(type: string): StoredPart[] {
  return readAll().filter(p => p.type === type)
}

export function getGenres(): { genre: string; count: number }[] {
  const parts = readAll()
  const map: Record<string, number> = {}
  for (const p of parts) {
    const g = p.genre || 'untagged'
    map[g] = (map[g] || 0) + 1
  }
  return Object.entries(map)
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count)
}

export function deletePart(id: string): boolean {
  const parts = readAll()
  const filtered = parts.filter(p => p.id !== id)
  if (filtered.length === parts.length) return false
  writeAll(filtered)
  return true
}

export function updatePartTags(id: string, genre: string, tags: string[]): StoredPart | null {
  const parts = readAll()
  const part = parts.find(p => p.id === id)
  if (!part) return null
  part.genre = genre
  part.tags = tags
  writeAll(parts)
  return part
}
