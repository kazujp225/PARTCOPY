import React, { useState } from 'react'
import { SourceSection } from '../types'
import { SourcePreviewFrame } from './SourcePreviewFrame'

const FAMILY_LABELS: Record<string, string> = {
  navigation: 'Nav',
  hero: 'Hero',
  feature: 'Feature',
  social_proof: 'Social Proof',
  stats: 'Stats',
  pricing: 'Pricing',
  faq: 'FAQ',
  content: 'Content',
  cta: 'CTA',
  contact: 'Contact',
  recruit: 'Recruit',
  footer: 'Footer',
  news_list: 'News',
  timeline: 'Timeline',
  company_profile: 'Company',
  gallery: 'Gallery',
  logo_cloud: 'Logo Cloud'
}

const FAMILY_COLORS: Record<string, string> = {
  navigation: '#6366f1',
  hero: '#3b82f6',
  feature: '#10b981',
  social_proof: '#ec4899',
  stats: '#84cc16',
  pricing: '#8b5cf6',
  faq: '#14b8a6',
  content: '#64748b',
  cta: '#f59e0b',
  contact: '#f97316',
  recruit: '#06b6d4',
  footer: '#6b7280',
  news_list: '#a855f7',
  timeline: '#0ea5e9',
  company_profile: '#059669',
  gallery: '#06b6d4',
  logo_cloud: '#a855f7'
}

type SortOption = 'position' | 'confidence' | 'family' | 'source'

interface Props {
  sections: SourceSection[]
  onAdd: (sectionId: string) => void
  onRemove: (sectionId: string) => void
}

export function PartsPanel({ sections, onAdd, onRemove }: Props) {
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
  const filtered = sections
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
    })

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
          <h2>Parts ({sections.length})</h2>
          <span className="parts-results-count">{filtered.length}件表示</span>
        </div>
        <div className="parts-management-bar">
          <input
            type="search"
            className="parts-search-input"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="検索: family / domain / summary"
          />
          <select
            className="parts-select"
            value={sortBy}
            onChange={event => setSortBy(event.target.value as SortOption)}
          >
            <option value="position">抽出順</option>
            <option value="confidence">信頼度順</option>
            <option value="family">family順</option>
            <option value="source">source順</option>
          </select>
        </div>
        <div className="parts-toggle-row">
          <button className={`feature-toggle ${onlyImages ? 'active' : ''}`} onClick={() => setOnlyImages(prev => !prev)}>
            IMG
          </button>
          <button className={`feature-toggle ${onlyCta ? 'active' : ''}`} onClick={() => setOnlyCta(prev => !prev)}>
            CTA
          </button>
          <button className={`feature-toggle ${onlyForm ? 'active' : ''}`} onClick={() => setOnlyForm(prev => !prev)}>
            FORM
          </button>
          {hasActiveFilters && (
            <button className="inline-reset-btn" onClick={resetControls}>
              リセット
            </button>
          )}
        </div>
        <div className="parts-filters">
          <button className={`filter-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
            All ({sections.length})
          </button>
          {Object.entries(familyCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([family, count]) => (
              <button
                key={family}
                className={`filter-btn ${filter === family ? 'active' : ''}`}
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
                <span className="part-confidence">{Math.round(section.classifier_confidence * 100)}%</span>
              </div>
              {hoveredId === section.id && (
                <div className="part-overlay-actions">
                  <button className="add-btn-large" onClick={() => onAdd(section.id)}>+ Canvas</button>
                  <button className="remove-btn-small" onClick={() => onRemove(section.id)}>削除</button>
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
