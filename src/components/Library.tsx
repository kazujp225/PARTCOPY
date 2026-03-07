import React, { useState, useEffect, useCallback } from 'react'
import { SavedPart, GenreInfo } from '../types'

const BLOCK_COLORS: Record<string, string> = {
  hero: '#3b82f6', navigation: '#6366f1', feature: '#10b981', cta: '#f59e0b',
  pricing: '#8b5cf6', testimonial: '#ec4899', faq: '#14b8a6',
  footer: '#6b7280', contact: '#f97316', gallery: '#06b6d4',
  stats: '#84cc16', 'logo-cloud': '#a855f7', content: '#64748b', unknown: '#94a3b8'
}

interface Props {
  onAddToCanvas: (part: SavedPart) => void
}

export function Library({ onAddToCanvas }: Props) {
  const [genres, setGenres] = useState<GenreInfo[]>([])
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null)
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [parts, setParts] = useState<SavedPart[]>([])
  const [loading, setLoading] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const fetchGenres = useCallback(async () => {
    const res = await fetch('/api/library/genres')
    const data = await res.json()
    setGenres(data.genres)
  }, [])

  const fetchParts = useCallback(async () => {
    setLoading(true)
    let url = '/api/library'
    const params = new URLSearchParams()
    if (selectedGenre) params.set('genre', selectedGenre)
    if (selectedType) params.set('type', selectedType)
    if (params.toString()) url += '?' + params.toString()
    const res = await fetch(url)
    const data = await res.json()
    setParts(data.parts)
    setLoading(false)
  }, [selectedGenre, selectedType])

  useEffect(() => { fetchGenres() }, [fetchGenres])
  useEffect(() => { fetchParts() }, [fetchParts])

  const handleDelete = async (id: string) => {
    await fetch(`/api/library/${id}`, { method: 'DELETE' })
    setParts(prev => prev.filter(p => p.id !== id))
    fetchGenres()
  }

  // Get type counts from current parts list
  const typeCounts = parts.reduce<Record<string, number>>((acc, p) => {
    acc[p.type] = (acc[p.type] || 0) + 1
    return acc
  }, {})

  const displayed = selectedType
    ? parts.filter(p => p.type === selectedType)
    : parts

  return (
    <div className="library">
      <div className="library-sidebar">
        <h3 className="library-sidebar-title">Genres</h3>
        <button
          className={`library-genre-btn ${!selectedGenre ? 'active' : ''}`}
          onClick={() => setSelectedGenre(null)}
        >
          All ({genres.reduce((s, g) => s + g.count, 0)})
        </button>
        {genres.map(g => (
          <button
            key={g.genre}
            className={`library-genre-btn ${selectedGenre === g.genre ? 'active' : ''}`}
            onClick={() => setSelectedGenre(g.genre)}
          >
            {g.genre || 'untagged'} ({g.count})
          </button>
        ))}

        <h3 className="library-sidebar-title" style={{ marginTop: 20 }}>Block Types</h3>
        <button
          className={`library-genre-btn ${!selectedType ? 'active' : ''}`}
          onClick={() => setSelectedType(null)}
        >
          All types
        </button>
        {Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
          <button
            key={type}
            className={`library-genre-btn ${selectedType === type ? 'active' : ''}`}
            onClick={() => setSelectedType(type)}
          >
            <span className="filter-dot" style={{ background: BLOCK_COLORS[type] || '#94a3b8' }} />
            {type} ({count})
          </button>
        ))}
      </div>

      <div className="library-grid">
        {loading && <div className="library-loading">Loading...</div>}
        {!loading && displayed.length === 0 && (
          <div className="library-empty">
            <p>保存されたパーツがありません</p>
            <p className="library-empty-hint">Extractしたパーツを「Save to Library」で保存してください</p>
          </div>
        )}
        {displayed.map(part => (
          <div
            key={part.id}
            className="library-card"
            onMouseEnter={() => setHoveredId(part.id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            <div className="library-card-thumb">
              {part.thumbnail ? (
                <img src={part.thumbnail} alt={part.type} loading="lazy" />
              ) : (
                <div className="library-card-no-thumb">No Preview</div>
              )}
              <div className="part-overlay-top">
                <span className="part-type-badge" style={{ background: BLOCK_COLORS[part.type] || '#94a3b8' }}>
                  {part.type}
                </span>
              </div>
              {hoveredId === part.id && (
                <div className="part-overlay-actions">
                  <button className="add-btn-large" onClick={() => onAddToCanvas(part)}>
                    + Canvas に追加
                  </button>
                  <button className="remove-btn-small" onClick={() => handleDelete(part.id)}>
                    削除
                  </button>
                </div>
              )}
            </div>
            <div className="library-card-info">
              <div className="library-card-genre">
                {part.genre && <span className="genre-badge">{part.genre}</span>}
                {part.tags.map(t => <span key={t} className="tag-badge">{t}</span>)}
              </div>
              <div className="part-source">{new URL(part.sourceUrl).hostname}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
