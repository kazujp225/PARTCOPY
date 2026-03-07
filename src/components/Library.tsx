import React, { useState, useEffect, useCallback } from 'react'
import { SourceSection, GenreInfo, BlockFamilyInfo } from '../types'

const FAMILY_COLORS: Record<string, string> = {
  navigation: '#6366f1', hero: '#3b82f6', feature: '#10b981', social_proof: '#ec4899',
  stats: '#84cc16', pricing: '#8b5cf6', faq: '#14b8a6', content: '#64748b',
  cta: '#f59e0b', contact: '#f97316', recruit: '#06b6d4', footer: '#6b7280',
  news_list: '#a855f7', timeline: '#0ea5e9', company_profile: '#059669',
  gallery: '#06b6d4', logo_cloud: '#a855f7'
}

interface Props {
  onAddToCanvas: (section: SourceSection) => void
}

export function Library({ onAddToCanvas }: Props) {
  const [genres, setGenres] = useState<GenreInfo[]>([])
  const [families, setFamilies] = useState<BlockFamilyInfo[]>([])
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null)
  const [selectedFamily, setSelectedFamily] = useState<string | null>(null)
  const [sections, setSections] = useState<SourceSection[]>([])
  const [loading, setLoading] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const fetchMeta = useCallback(async () => {
    const [gRes, fRes] = await Promise.all([
      fetch('/api/library/genres'),
      fetch('/api/library/families')
    ])
    const gData = await gRes.json()
    const fData = await fRes.json()
    setGenres(gData.genres || [])
    setFamilies(fData.families || [])
  }, [])

  const fetchSections = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (selectedGenre) params.set('genre', selectedGenre)
    if (selectedFamily) params.set('family', selectedFamily)
    const res = await fetch(`/api/library?${params}`)
    const data = await res.json()
    setSections(data.sections || [])
    setLoading(false)
  }, [selectedGenre, selectedFamily])

  useEffect(() => { fetchMeta() }, [fetchMeta])
  useEffect(() => { fetchSections() }, [fetchSections])

  const handleDelete = async (id: string) => {
    await fetch(`/api/library/${id}`, { method: 'DELETE' })
    setSections(prev => prev.filter(s => s.id !== id))
    fetchMeta()
  }

  return (
    <div className="library">
      <div className="library-sidebar">
        <h3 className="library-sidebar-title">Genres</h3>
        <button className={`library-genre-btn ${!selectedGenre ? 'active' : ''}`} onClick={() => setSelectedGenre(null)}>
          All
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

        <h3 className="library-sidebar-title" style={{ marginTop: 20 }}>Block Families</h3>
        <button className={`library-genre-btn ${!selectedFamily ? 'active' : ''}`} onClick={() => setSelectedFamily(null)}>
          All families
        </button>
        {families.map(f => (
          <button
            key={f.key}
            className={`library-genre-btn ${selectedFamily === f.key ? 'active' : ''}`}
            onClick={() => setSelectedFamily(f.key)}
          >
            <span className="filter-dot" style={{ background: FAMILY_COLORS[f.key] || '#94a3b8' }} />
            {f.label_ja}
          </button>
        ))}
      </div>

      <div className="library-grid">
        {loading && <div className="library-loading">Loading...</div>}
        {!loading && sections.length === 0 && (
          <div className="library-empty">
            <p>保存されたパーツがありません</p>
            <p className="library-empty-hint">URLを抽出するとライブラリに自動保存されます</p>
          </div>
        )}
        {sections.map(sec => (
          <div
            key={sec.id}
            className="library-card"
            onMouseEnter={() => setHoveredId(sec.id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            <div className="library-card-thumb">
              {sec.thumbnailUrl ? (
                <img src={sec.thumbnailUrl} alt={sec.block_family} loading="lazy" />
              ) : (
                <div className="library-card-no-thumb">No Preview</div>
              )}
              <div className="part-overlay-top">
                <span className="part-type-badge" style={{ background: FAMILY_COLORS[sec.block_family] || '#94a3b8' }}>
                  {sec.block_family}
                </span>
              </div>
              {hoveredId === sec.id && (
                <div className="part-overlay-actions">
                  <button className="add-btn-large" onClick={() => onAddToCanvas(sec)}>+ Canvas</button>
                  <button className="remove-btn-small" onClick={() => handleDelete(sec.id)}>削除</button>
                </div>
              )}
            </div>
            <div className="library-card-info">
              <div className="library-card-genre">
                {sec.source_sites?.genre && <span className="genre-badge">{sec.source_sites.genre}</span>}
                {sec.source_sites?.tags?.map(t => <span key={t} className="tag-badge">{t}</span>)}
              </div>
              <div className="part-source">{sec.source_sites?.normalized_domain || ''}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
