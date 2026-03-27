import React, { useCallback, useEffect, useState } from 'react'
import { SourceSection, GenreInfo, BlockFamilyInfo } from '../types'
// サムネイル画像を使用（iframeより軽量）
import { FAMILY_COLORS, FAMILY_LABELS } from '../constants'

type SortOption = 'newest' | 'confidence' | 'family' | 'source'

interface Props {
  onAddToCanvas: (section: SourceSection) => void
  initialFamily?: string | null
}

export function Library({ onAddToCanvas, initialFamily }: Props) {
  const [genres, setGenres] = useState<GenreInfo[]>([])
  const [families, setFamilies] = useState<BlockFamilyInfo[]>([])
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null)
  const [selectedFamily, setSelectedFamily] = useState<string | null>(initialFamily || null)
  const [sections, setSections] = useState<SourceSection[]>([])
  const [loading, setLoading] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>('newest')
  const [limit, setLimit] = useState(60)
  const [onlyCta, setOnlyCta] = useState(false)
  const [onlyForm, setOnlyForm] = useState(false)
  const [onlyImages, setOnlyImages] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sync with sidebar category selection
  useEffect(() => {
    if (initialFamily !== undefined) setSelectedFamily(initialFamily || null)
  }, [initialFamily])

  const familyLabelMap = families.reduce<Record<string, string>>((acc, family) => {
    acc[family.key] = family.label_ja || family.label || family.key
    return acc
  }, {})

  const fetchMeta = useCallback(async () => {
    try {
      const [genreResponse, familyResponse] = await Promise.all([
        fetch('/api/library/genres'),
        fetch('/api/library/families')
      ])

      if (!genreResponse.ok || !familyResponse.ok) {
        throw new Error('ライブラリの集計情報を取得できませんでした')
      }

      const genreData = await genreResponse.json()
      const familyData = await familyResponse.json()
      setGenres(genreData.genres || [])
      setFamilies(familyData.families || [])
    } catch (fetchError: any) {
      setError(fetchError.message || 'ライブラリの集計情報を取得できませんでした')
    }
  }, [])

  const fetchSections = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      params.set('limit', String(limit))
      params.set('sort', sortBy)
      if (selectedGenre) params.set('genre', selectedGenre)
      if (selectedFamily) params.set('family', selectedFamily)
      if (query.trim()) params.set('q', query.trim())
      if (onlyCta) params.set('hasCta', 'true')
      if (onlyForm) params.set('hasForm', 'true')
      if (onlyImages) params.set('hasImages', 'true')

      const response = await fetch(`/api/library?${params.toString()}`)
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.error || 'ライブラリの取得に失敗しました')
      }

      const data = await response.json()
      setSections(data.sections || [])
    } catch (fetchError: any) {
      setSections([])
      setError(fetchError.message || 'ライブラリの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [limit, onlyCta, onlyForm, onlyImages, query, selectedFamily, selectedGenre, sortBy])

  useEffect(() => {
    fetchMeta()
  }, [fetchMeta])

  useEffect(() => {
    fetchSections()
  }, [fetchSections])

  const handleDelete = async (id: string) => {
    setError(null)

    try {
      const response = await fetch(`/api/library/${id}`, { method: 'DELETE' })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.error || '削除に失敗しました')
      }

      setSections(prev => prev.filter(section => section.id !== id))
      fetchMeta()
    } catch (deleteError: any) {
      setError(deleteError.message || '削除に失敗しました')
    }
  }

  const resetControls = () => {
    setSelectedGenre(null)
    setSelectedFamily(null)
    setQuery('')
    setSortBy('newest')
    setLimit(60)
    setOnlyCta(false)
    setOnlyForm(false)
    setOnlyImages(false)
  }

  const totalGenreCount = genres.reduce((sum, genre) => sum + genre.count, 0)
  const hasActiveFilters = Boolean(
    selectedGenre ||
    selectedFamily ||
    query.trim() ||
    onlyCta ||
    onlyForm ||
    onlyImages ||
    sortBy !== 'newest' ||
    limit !== 60
  )

  return (
    <div className="library">
      <div className="library-sidebar">
        <h3 className="library-sidebar-title">ジャンル</h3>
        <button className={`library-genre-btn ${!selectedGenre ? 'active' : ''}`} onClick={() => setSelectedGenre(null)}>
          すべて ({totalGenreCount})
        </button>
        {genres.map(genre => (
          <button
            key={genre.genre}
            className={`library-genre-btn ${selectedGenre === genre.genre ? 'active' : ''}`}
            onClick={() => setSelectedGenre(genre.genre)}
          >
            {genre.genre || '未分類'} ({genre.count})
          </button>
        ))}

        <h3 className="library-sidebar-title" style={{ marginTop: 20 }}>ブロック種別</h3>
        <button className={`library-genre-btn ${!selectedFamily ? 'active' : ''}`} onClick={() => setSelectedFamily(null)}>
          すべての種別
        </button>
        {families.map(family => (
          <button
            key={family.key}
            className={`library-genre-btn ${selectedFamily === family.key ? 'active' : ''}`}
            onClick={() => setSelectedFamily(family.key)}
          >
            <span className="filter-dot" style={{ background: FAMILY_COLORS[family.key] || '#94a3b8' }} />
            {family.label_ja} {typeof family.count === 'number' ? `(${family.count})` : ''}
          </button>
        ))}
      </div>

      <div className="library-main">
        <div className="library-toolbar">
          <div className="library-toolbar-row">
            <input
              type="search"
              className="parts-search-input"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="検索: ドメイン / ジャンル / タグ / 概要"
            />
            <select
              className="parts-select"
              value={sortBy}
              onChange={event => setSortBy(event.target.value as SortOption)}
            >
              <option value="newest">新着順</option>
              <option value="confidence">信頼度順</option>
              <option value="family">種別順</option>
              <option value="source">サイト順</option>
            </select>
            <select
              className="parts-select"
              value={String(limit)}
              onChange={event => setLimit(Number(event.target.value))}
            >
              <option value="24">24件</option>
              <option value="60">60件</option>
              <option value="120">120件</option>
            </select>
          </div>

          <div className="parts-toggle-row library-toggle-row">
            <button className={`feature-toggle ${onlyImages ? 'active' : ''}`} onClick={() => setOnlyImages(prev => !prev)}>
              IMG
            </button>
            <button className={`feature-toggle ${onlyCta ? 'active' : ''}`} onClick={() => setOnlyCta(prev => !prev)}>
              CTA
            </button>
            <button className={`feature-toggle ${onlyForm ? 'active' : ''}`} onClick={() => setOnlyForm(prev => !prev)}>
              FORM
            </button>
            <span className="parts-results-count">{sections.length}件表示</span>
            {hasActiveFilters && (
              <button className="inline-reset-btn" onClick={resetControls}>
                条件をリセット
              </button>
            )}
          </div>
        </div>

        <div className="library-grid">
          {loading && (
            <div className="library-loading">
              <div className="loading-spinner" />
              <span>最新情報を取得しています...</span>
            </div>
          )}
          {!loading && error && (
            <div className="library-empty">
              <p>{error}</p>
            </div>
          )}
          {!loading && !error && sections.length === 0 && (
            <div className="library-empty">
              <p>条件に一致するパーツがありません</p>
              <p className="library-empty-hint">フィルターを戻すか、新しい URL を抽出してください</p>
            </div>
          )}
          {!loading && !error && sections.map(section => (
            <div
              key={section.id}
              className="library-card"
              onMouseEnter={() => setHoveredId(section.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <div className="library-card-thumb">
                {section.thumbnail_storage_path ? (
                  <img src={`/assets/${section.thumbnail_storage_path}`} alt={section.block_family} loading="lazy" />
                ) : (
                  <div className="library-card-no-thumb">
                    <span className="library-card-no-thumb-icon" style={{ color: FAMILY_COLORS[section.block_family] || '#94a3b8' }}>
                      {FAMILY_LABELS[section.block_family] || section.block_family}
                    </span>
                  </div>
                )}
                <div className="library-card-category">
                  <span style={{ background: FAMILY_COLORS[section.block_family] || '#94a3b8' }}>
                    {familyLabelMap[section.block_family] || section.block_family}
                  </span>
                </div>
                {hoveredId === section.id && (
                  <div className="library-card-hover">
                    <button className="library-card-add" onClick={() => onAddToCanvas(section)}>+ Canvasに追加</button>
                    <button className="library-card-delete" onClick={() => handleDelete(section.id)}>削除</button>
                  </div>
                )}
              </div>
              <div className="library-card-body">
                <h3 className="library-card-title">{section.source_sites?.normalized_domain || 'Unknown'}</h3>
                {section.text_summary && <p className="library-card-desc">{section.text_summary}</p>}
                <div className="library-card-meta">
                  {section.source_sites?.genre && <span className="library-card-genre-tag">{section.source_sites.genre}</span>}
                  {section.features_jsonb?.hasImages && <span className="library-card-feat">IMG</span>}
                  {section.features_jsonb?.hasCTA && <span className="library-card-feat cta">CTA</span>}
                  {section.features_jsonb?.hasForm && <span className="library-card-feat form">FORM</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
