import React, { useState, useMemo } from 'react'
import { SourceSection } from '../types'
import { SourcePreviewFrame } from './SourcePreviewFrame'
import { FAMILY_COLORS } from '../constants'

const FAMILY_LABELS: Record<string, string> = {
  navigation: 'ナビ',
  hero: 'ヒーロー',
  feature: '特徴',
  social_proof: '実績・声',
  stats: '数値',
  pricing: '料金',
  faq: 'FAQ',
  content: 'コンテンツ',
  cta: 'CTA',
  contact: 'お問い合わせ',
  recruit: '採用',
  footer: 'フッター',
  news_list: 'お知らせ',
  timeline: '沿革',
  company_profile: '会社概要',
  gallery: 'ギャラリー',
  logo_cloud: 'ロゴ一覧'
}


type SortOption = 'position' | 'confidence' | 'family' | 'source'

interface Props {
  sections: SourceSection[]
  onAdd: (sectionId: string) => void
  onRemove: (sectionId: string) => void
  onViewTsx?: (sectionId: string) => void
}

export function PartsPanel({ sections, onAdd, onRemove, onViewTsx }: Props) {
  const [filter, setFilter] = useState<string | 'all'>('all')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>('position')
  const [onlyCta, setOnlyCta] = useState(false)
  const [onlyForm, setOnlyForm] = useState(false)
  const [onlyImages, setOnlyImages] = useState(false)

  const familyCounts = sections.reduce<Record<string, number>>((acc, section) => {
    const family = section.block_family || 'content'
    acc[family] = (acc[family] || 0) + 1
    return acc
  }, {})

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = useMemo(() => sections
    .filter(section => {
      if (filter !== 'all' && section.block_family !== filter) return false
      if (onlyCta && !section.features_jsonb?.hasCTA) return false
      if (onlyForm && !section.features_jsonb?.hasForm) return false
      if (onlyImages && !section.features_jsonb?.hasImages) return false
      if (!normalizedQuery) return true

      const searchable = [
        section.block_family,
        section.block_variant,
        section.text_summary,
        section.source_sites?.normalized_domain,
        section.source_pages?.title,
        section.source_pages?.url
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return searchable.includes(normalizedQuery)
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'confidence':
          return b.classifier_confidence - a.classifier_confidence
        case 'family':
          return String(a.block_family || '').localeCompare(String(b.block_family || ''))
        case 'source':
          return String(a.source_sites?.normalized_domain || '').localeCompare(String(b.source_sites?.normalized_domain || ''))
        case 'position':
        default:
          return a.order_index - b.order_index
      }
    }), [sections, filter, normalizedQuery, sortBy, onlyCta, onlyForm, onlyImages])

  const hasActiveFilters = filter !== 'all' || normalizedQuery.length > 0 || onlyCta || onlyForm || onlyImages || sortBy !== 'position'

  const resetControls = () => {
    setFilter('all')
    setQuery('')
    setSortBy('position')
    setOnlyCta(false)
    setOnlyForm(false)
    setOnlyImages(false)
  }

  if (sections.length === 0) {
    return (
      <aside className="parts-panel">
        <div className="parts-empty">
          <div className="parts-empty-icon">&#9881;</div>
          <p>URLを入力してサイトのパーツを抽出してください</p>
        </div>
      </aside>
    )
  }

  return (
    <aside className="parts-panel">
      <div className="parts-header">
        <div className="parts-header-row">
          <h2>{sections.length}件のパーツ</h2>
          <span className="parts-results-count">{filtered.length}件表示</span>
        </div>
        <div className="parts-management-bar">
          <input
            type="search"
            className="parts-search-input"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="検索: 種別 / ドメイン / 概要"
          />
          <select
            className="parts-select"
            value={sortBy}
            onChange={event => setSortBy(event.target.value as SortOption)}
          >
            <option value="position">抽出順</option>
            <option value="confidence">信頼度順</option>
            <option value="family">種別順</option>
            <option value="source">サイト順</option>
          </select>
        </div>
        <div className="parts-toggle-row">
          <button className={`feature-toggle pill ${onlyImages ? 'active' : ''}`} onClick={() => setOnlyImages(prev => !prev)}>
            IMG
          </button>
          <button className={`feature-toggle pill ${onlyCta ? 'active' : ''}`} onClick={() => setOnlyCta(prev => !prev)}>
            CTA
          </button>
          <button className={`feature-toggle pill ${onlyForm ? 'active' : ''}`} onClick={() => setOnlyForm(prev => !prev)}>
            FORM
          </button>
          {hasActiveFilters && (
            <button className="inline-reset-btn" onClick={resetControls}>
              リセット
            </button>
          )}
        </div>
        <div className="parts-filters">
          <button className={`filter-btn pill ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
            すべて ({sections.length})
          </button>
          {Object.entries(familyCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([family, count]) => (
              <button
                key={family}
                className={`filter-btn pill ${filter === family ? 'active' : ''}`}
                onClick={() => setFilter(family)}
              >
                <span className="filter-dot" style={{ background: FAMILY_COLORS[family] || '#94a3b8' }} />
                {FAMILY_LABELS[family] || family} ({count})
              </button>
            ))}
        </div>
      </div>

      <div className="parts-list">
        {filtered.length === 0 && (
          <div className="parts-empty-results">
            <p>条件に一致するパーツがありません</p>
            <button className="inline-reset-btn" onClick={resetControls}>
              条件をクリア
            </button>
          </div>
        )}

        {filtered.map(section => (
          <div
            key={section.id}
            className="part-card"
            onMouseEnter={() => setHoveredId(section.id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            <div className="part-thumbnail-wrap">
              <SourcePreviewFrame htmlUrl={section.htmlUrl} maxHeight={300} scale={0.45} />
              <div className="part-overlay-top">
                <span className="part-type-badge" style={{ background: FAMILY_COLORS[section.block_family] || '#94a3b8' }}>
                  {FAMILY_LABELS[section.block_family] || section.block_family}
                </span>
                {section.tsx_code_storage_path && <span className="tsx-ready-badge">TSX</span>}
                <span className="part-confidence">{Math.round(section.classifier_confidence * 100)}%</span>
              </div>
              {hoveredId === section.id && (
                <div className="part-overlay-actions">
                  <button className="add-btn-large" onClick={() => onAdd(section.id)}>+ 追加</button>
                  {section.tsx_code_storage_path && onViewTsx && (
                    <button className="tsx-btn" onClick={() => onViewTsx(section.id)}>TSX</button>
                  )}
                </div>
              )}
            </div>
            <div className="part-content">
              {section.block_variant && <div className="part-variant">{section.block_variant}</div>}
              {section.text_summary && <p className="part-summary">{section.text_summary}</p>}
              <div className="part-info-bar">
                <div className="part-meta-tags">
                  {section.features_jsonb?.hasImages && <span className="meta-tag">IMG</span>}
                  {section.features_jsonb?.hasCTA && <span className="meta-tag cta">CTA</span>}
                  {section.features_jsonb?.hasForm && <span className="meta-tag form">FORM</span>}
                </div>
                <div className="part-source">
                  {section.source_sites?.normalized_domain || section.source_pages?.url?.replace(/https?:\/\//, '').split('/')[0] || ''}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}
