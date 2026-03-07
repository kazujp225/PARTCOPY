import React, { useState } from 'react'
import { SourceSection, BlockFamily } from '../types'

const FAMILY_LABELS: Record<string, string> = {
  navigation: 'Nav', hero: 'Hero', feature: 'Feature', social_proof: 'Social Proof',
  stats: 'Stats', pricing: 'Pricing', faq: 'FAQ', content: 'Content',
  cta: 'CTA', contact: 'Contact', recruit: 'Recruit', footer: 'Footer',
  news_list: 'News', timeline: 'Timeline', company_profile: 'Company',
  gallery: 'Gallery', logo_cloud: 'Logo Cloud'
}

const FAMILY_COLORS: Record<string, string> = {
  navigation: '#6366f1', hero: '#3b82f6', feature: '#10b981', social_proof: '#ec4899',
  stats: '#84cc16', pricing: '#8b5cf6', faq: '#14b8a6', content: '#64748b',
  cta: '#f59e0b', contact: '#f97316', recruit: '#06b6d4', footer: '#6b7280',
  news_list: '#a855f7', timeline: '#0ea5e9', company_profile: '#059669',
  gallery: '#06b6d4', logo_cloud: '#a855f7'
}

interface Props {
  sections: SourceSection[]
  onAdd: (sectionId: string) => void
  onRemove: (sectionId: string) => void
}

export function PartsPanel({ sections, onAdd, onRemove }: Props) {
  const [filter, setFilter] = useState<string | 'all'>('all')
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const filtered = filter === 'all' ? sections : sections.filter(s => s.block_family === filter)

  const familyCounts = sections.reduce<Record<string, number>>((acc, s) => {
    const f = s.block_family || 'content'
    acc[f] = (acc[f] || 0) + 1
    return acc
  }, {})

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
      <div className="parts-header"><h2>Parts ({sections.length})</h2></div>
      <div className="parts-filters">
        <button className={`filter-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
          All ({sections.length})
        </button>
        {Object.entries(familyCounts).sort((a, b) => b[1] - a[1]).map(([fam, count]) => (
          <button key={fam} className={`filter-btn ${filter === fam ? 'active' : ''}`} onClick={() => setFilter(fam)}>
            <span className="filter-dot" style={{ background: FAMILY_COLORS[fam] || '#94a3b8' }} />
            {FAMILY_LABELS[fam] || fam} ({count})
          </button>
        ))}
      </div>
      <div className="parts-list">
        {filtered.map(sec => (
          <div
            key={sec.id}
            className={`part-card ${hoveredId === sec.id ? 'hovered' : ''}`}
            onMouseEnter={() => setHoveredId(sec.id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            <div className="part-thumbnail-wrap">
              {sec.thumbnailUrl ? (
                <img src={sec.thumbnailUrl} alt={sec.block_family} className="part-thumbnail" loading="lazy" />
              ) : (
                <div className="part-thumbnail-placeholder">No Preview</div>
              )}
              <div className="part-overlay-top">
                <span className="part-type-badge" style={{ background: FAMILY_COLORS[sec.block_family] || '#94a3b8' }}>
                  {FAMILY_LABELS[sec.block_family] || sec.block_family}
                </span>
                <span className="part-confidence">{Math.round(sec.classifier_confidence * 100)}%</span>
              </div>
              {hoveredId === sec.id && (
                <div className="part-overlay-actions">
                  <button className="add-btn-large" onClick={() => onAdd(sec.id)}>+ Canvas</button>
                  <button className="remove-btn-small" onClick={() => onRemove(sec.id)}>削除</button>
                </div>
              )}
            </div>
            <div className="part-info-bar">
              <div className="part-meta-tags">
                {sec.features_jsonb?.hasImages && <span className="meta-tag">IMG</span>}
                {sec.features_jsonb?.hasCTA && <span className="meta-tag cta">CTA</span>}
                {sec.features_jsonb?.hasForm && <span className="meta-tag form">FORM</span>}
              </div>
              <div className="part-source">
                {sec.source_sites?.normalized_domain || sec.source_pages?.url?.replace(/https?:\/\//, '').split('/')[0] || ''}
              </div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}
