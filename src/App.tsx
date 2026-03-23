import React, { useState, useCallback, useEffect, useRef } from 'react'
import { SourceSection, CanvasBlock, CrawlJob, JobStatus } from './types'
import { URLInput } from './components/URLInput'
import { PartsPanel } from './components/PartsPanel'
import { Canvas } from './components/Canvas'
import { Preview } from './components/Preview'
import { Library } from './components/Library'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TsxModal } from './components/TsxModal'
import './styles.css'

type View = 'editor' | 'preview' | 'library'

const CANVAS_STORAGE_KEY = 'partcopy:canvas'
const CANVAS_STORAGE_VERSION = 1

function loadCanvasFromStorage(): CanvasBlock[] {
  try {
    const raw = localStorage.getItem(CANVAS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== CANVAS_STORAGE_VERSION) return []
    return Array.isArray(parsed.canvas) ? parsed.canvas : []
  } catch { return [] }
}

export default function App() {
  const [sections, setSections] = useState<SourceSection[]>([])
  const [canvas, setCanvas] = useState<CanvasBlock[]>(loadCanvasFromStorage)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobStatus, setJobStatus] = useState<string | null>(null)
  const [view, setView] = useState<View>('editor')
  const pollRef = useRef<NodeJS.Timeout | null>(null)
  const [tsxResult, setTsxResult] = useState<{ tsx: string; familyName?: string } | null>(null)
  const [exporting, setExporting] = useState(false)

  // Auto-crawl state
  const [crawlQueueCount, setCrawlQueueCount] = useState(0)
  const [crawlDoneCount, setCrawlDoneCount] = useState(0)
  const [crawlActive, setCrawlActive] = useState(false)
  const [crawlCurrentUrl, setCrawlCurrentUrl] = useState<string | null>(null)
  const [crawlUrls, setCrawlUrls] = useState('')
  const [crawlExpanded, setCrawlExpanded] = useState(false)
  const [crawlSubmitting, setCrawlSubmitting] = useState(false)

  // Persist canvas to localStorage (debounced to avoid excessive writes)
  useEffect(() => {
    const timer = setTimeout(() => {
      localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ version: CANVAS_STORAGE_VERSION, canvas }))
    }, 300)
    return () => clearTimeout(timer)
  }, [canvas])

  // Restore sections for canvas items on mount
  useEffect(() => {
    const stored = loadCanvasFromStorage()
    if (stored.length === 0) return
    const sectionIds = [...new Set(stored.map(c => c.sectionId))]
    Promise.all(
      sectionIds.map(id =>
        fetch(`/api/sections/${id}/html`)
          .then(r => r.ok ? r.json() : null)
          .then(data => data ? { id, htmlUrl: `/api/sections/${id}/render` } : null)
          .catch(() => null)
      )
    ).then(results => {
      // Fetch full section data from library
      fetch(`/api/library?limit=200`)
        .then(r => r.json())
        .then(data => {
          const libSections: SourceSection[] = data.sections || []
          const libMap = new Map(libSections.map((s: SourceSection) => [s.id, s]))
          setSections(prev => {
            const seen = new Set(prev.map(s => s.id))
            const next = [...prev]
            for (const id of sectionIds) {
              if (seen.has(id) || !libMap.has(id)) continue
              seen.add(id)
              next.push(libMap.get(id)!)
            }
            return next
          })
        })
        .catch(() => {})
    })
  }, [])
  // Poll crawl queue status (only when the auto-crawl section is expanded)
  useEffect(() => {
    if (!crawlExpanded) return

    const fetchCrawlStatus = async () => {
      try {
        const res = await fetch('/api/crawl-queue')
        if (res.ok) {
          const data = await res.json()
          setCrawlQueueCount(data.queue?.length || 0)
          setCrawlDoneCount(data.done?.length || 0)
          setCrawlActive(data.active || false)
          setCrawlCurrentUrl(data.currentUrl || null)
        }
      } catch {
        // Server likely down, ignore silently
      }
    }
    fetchCrawlStatus()
    const interval = setInterval(fetchCrawlStatus, 10_000)
    return () => clearInterval(interval)
  }, [crawlExpanded])

  const handleCrawlSubmit = useCallback(async () => {
    const urls = crawlUrls
      .split('\n')
      .map(u => u.trim())
      .filter(u => u.length > 0)
    if (urls.length === 0) return

    setCrawlSubmitting(true)
    try {
      const res = await fetch('/api/crawl-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls })
      })
      if (res.ok) {
        const data = await res.json()
        setCrawlQueueCount(data.queue?.length || 0)
        setCrawlDoneCount(data.done?.length || 0)
        setCrawlActive(data.active || false)
        setCrawlUrls('')
      }
    } catch {}
    setCrawlSubmitting(false)
  }, [crawlUrls])

  const handleCrawlClear = useCallback(async () => {
    try {
      const res = await fetch('/api/crawl-queue', { method: 'DELETE' })
      if (res.ok) {
        setCrawlQueueCount(0)
      }
    } catch {}
  }, [])

  const familyCount = new Set(sections.map(section => section.block_family)).size
  const sourceCount = new Set(
    sections
      .map(section => section.source_sites?.normalized_domain)
      .filter((domain): domain is string => Boolean(domain))
  ).size

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  useEffect(() => () => stopPolling(), [])

  const pollJob = useCallback((jobId: string) => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`)
        if (!res.ok) return // skip transient errors, will retry next interval
        const { job } = await res.json() as { job: CrawlJob }
        if (!job) return
        const detail = job.status_detail || ''
        setJobStatus(`${job.status}${detail ? ` - ${detail}` : ''}${job.section_count ? ` (${job.section_count} sections)` : ''}`)

        if (job.status === 'done') {
          stopPolling()
          // Fetch sections
          const secRes = await fetch(`/api/jobs/${jobId}/sections`)
          if (!secRes.ok) { setLoading(false); setJobStatus(null); return }
          const secData = await secRes.json()
          const secs = secData.sections || []
          setSections(prev => {
            const seen = new Set(prev.map(section => section.id))
            const next = [...prev]
            for (const section of secs) {
              if (seen.has(section.id)) continue
              seen.add(section.id)
              next.push(section)
            }
            return next
          })
          setLoading(false)
          setJobStatus(null)
        } else if (job.status === 'failed') {
          stopPolling()
          setError(job.error_message || 'Crawl failed')
          setLoading(false)
          setJobStatus(null)
        }
      } catch {
        // Ignore transient fetch errors
      }
    }, 2000)
  }, [])

  const handleExtract = useCallback(async (url: string, genre: string, tags: string[]) => {
    setLoading(true)
    setError(null)
    setJobStatus('queuing...')
    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, genre, tags })
      })
      if (!res.ok) {
        let message = 'Failed to create job'
        try {
          const data = await res.json()
          message = data.error || message
        } catch {}
        throw new Error(message)
      }
      const { jobId } = await res.json()
      setJobStatus('queued - waiting for worker...')
      pollJob(jobId)
    } catch (err: any) {
      setError(err.message)
      setLoading(false)
      setJobStatus(null)
    }
  }, [pollJob])

  const addToCanvas = useCallback((sectionId: string) => {
    setCanvas(prev => {
      if (prev.some(c => c.sectionId === sectionId)) return prev
      return [...prev, { id: crypto.randomUUID(), sectionId, position: prev.length }]
    })
  }, [])

  const addSavedToCanvas = useCallback((section: SourceSection) => {
    // Add to sections if not already present
    setSections(prev => {
      if (prev.find(s => s.id === section.id)) return prev
      return [...prev, section]
    })
    setCanvas(prev => {
      if (prev.some(c => c.sectionId === section.id)) return prev
      return [...prev, { id: crypto.randomUUID(), sectionId: section.id, position: prev.length }]
    })
    setView('editor')
  }, [])

  const removeFromCanvas = useCallback((canvasId: string) => {
    setCanvas(prev => prev.filter(c => c.id !== canvasId))
  }, [])

  const moveBlock = useCallback((fromIndex: number, toIndex: number) => {
    setCanvas(prev => {
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next.map((c, i) => ({ ...c, position: i }))
    })
  }, [])

  const removeSection = useCallback(async (sectionId: string) => {
    try {
      await fetch(`/api/sections/${sectionId}`, { method: 'DELETE' })
    } catch {}
    setSections(prev => prev.filter(s => s.id !== sectionId))
    setCanvas(prev => prev.filter(c => c.sectionId !== sectionId))
  }, [])

  const handleViewTsx = useCallback(async (sectionId: string) => {
    try {
      const res = await fetch(`/api/sections/${sectionId}/tsx`)
      if (!res.ok) {
        let message = 'TSXが見つかりません'
        try {
          const data = await res.json()
          message = data.error || message
        } catch {}
        throw new Error(message)
      }
      const { tsx, blockFamily } = await res.json()
      setTsxResult({ tsx, familyName: blockFamily })
    } catch (err: any) {
      alert(err.message)
    }
  }, [])

  const handleExportZip = useCallback(async () => {
    if (canvas.length === 0) return
    setExporting(true)
    try {
      const sectionIds = canvas.map(c => c.sectionId)
      const res = await fetch('/api/export/zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionIds })
      })
      if (!res.ok) throw new Error('ZIP出力に失敗しました')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'partcopy-export.zip'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      alert(err.message)
    } finally {
      setExporting(false)
    }
  }, [canvas])

  const canvasItems = canvas.map(c => ({
    canvas: c,
    section: sections.find(s => s.id === c.sectionId)!
  })).filter(c => c.section)

  return (
    <div className="app">
      <ErrorBoundary>
      <header className="app-header">
        <div className="app-logo">
          <h1>PARTCOPY</h1>
          <span className="app-tagline">Site Genome OS</span>
        </div>
        <div className="app-actions">
          <button className={`view-btn ${view === 'editor' ? 'active' : ''}`} onClick={() => setView('editor')}>
            Editor
          </button>
          <button className={`view-btn ${view === 'library' ? 'active' : ''}`} onClick={() => setView('library')}>
            Library
          </button>
          <button className={`view-btn ${view === 'preview' ? 'active' : ''}`} onClick={() => setView('preview')}>
            Preview
          </button>
        </div>
      </header>

      <div className="workspace-summary">
        <div className="workspace-stat">
          <span className="workspace-stat-label">抽出パーツ</span>
          <strong>{sections.length}</strong>
        </div>
        <div className="workspace-stat">
          <span className="workspace-stat-label">ファミリー</span>
          <strong>{familyCount}</strong>
        </div>
        <div className="workspace-stat">
          <span className="workspace-stat-label">Canvas</span>
          <strong>{canvas.length}</strong>
        </div>
        <div className="workspace-stat">
          <span className="workspace-stat-label">参照サイト</span>
          <strong>{sourceCount}</strong>
        </div>
      </div>

      {view !== 'library' && (
        <div className="auto-crawl-section">
          <div className="auto-crawl-header" onClick={() => setCrawlExpanded(!crawlExpanded)}>
            <span className="auto-crawl-toggle">{crawlExpanded ? '\u25BC' : '\u25B6'}</span>
            <span className="auto-crawl-title">Auto Crawl</span>
            <span className={`auto-crawl-status ${crawlActive ? 'active' : 'idle'}`}>
              {crawlActive ? 'Active' : 'Idle'}
            </span>
            <span className="auto-crawl-counts">
              Queue: {crawlQueueCount} | Done: {crawlDoneCount}
            </span>
          </div>
          {crawlExpanded && (
            <div className="auto-crawl-body">
              {crawlActive && crawlCurrentUrl && (
                <div className="auto-crawl-current">
                  Processing: <code>{crawlCurrentUrl}</code>
                </div>
              )}
              <textarea
                className="auto-crawl-textarea"
                placeholder="Paste URLs here (one per line)..."
                value={crawlUrls}
                onChange={e => setCrawlUrls(e.target.value)}
                rows={4}
              />
              <div className="auto-crawl-actions">
                <button
                  className="auto-crawl-btn start"
                  onClick={handleCrawlSubmit}
                  disabled={crawlSubmitting || !crawlUrls.trim()}
                >
                  {crawlSubmitting ? 'Adding...' : 'Add to Queue'}
                </button>
                <button
                  className="auto-crawl-btn clear"
                  onClick={handleCrawlClear}
                  disabled={crawlQueueCount === 0}
                >
                  Clear Queue
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {view !== 'library' && (
        <URLInput onSubmit={handleExtract} loading={loading} error={error} jobStatus={jobStatus} />
      )}

      {view === 'editor' && (
        <div className="editor-layout">
          <PartsPanel sections={sections} onAdd={addToCanvas} onRemove={removeSection} onViewTsx={handleViewTsx} />
          <Canvas items={canvasItems} onRemove={removeFromCanvas} onMove={moveBlock} onViewTsx={handleViewTsx} onExportZip={handleExportZip} exporting={exporting} />
        </div>
      )}

      {view === 'preview' && <Preview items={canvasItems} />}

      {view === 'library' && <Library onAddToCanvas={addSavedToCanvas} />}

      {tsxResult && (
        <TsxModal
          tsx={tsxResult.tsx}
          familyName={tsxResult.familyName}
          onClose={() => setTsxResult(null)}
        />
      )}
      </ErrorBoundary>
    </div>
  )
}
