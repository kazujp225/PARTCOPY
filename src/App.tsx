import React, { useState, useCallback, useEffect, useRef } from 'react'
import { SourceSection, CanvasBlock, CrawlJob, JobStatus } from './types'
import { URLInput } from './components/URLInput'
import { PartsPanel } from './components/PartsPanel'
import { Canvas } from './components/Canvas'
import { Preview } from './components/Preview'
import { Library } from './components/Library'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TsxModal } from './components/TsxModal'
import { Dashboard } from './components/Dashboard'
import './styles.css'

type View = 'dashboard' | 'editor' | 'preview' | 'library'

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
  const [view, setView] = useState<View>('dashboard')
  const pollRef = useRef<NodeJS.Timeout | null>(null)
  const [tsxResult, setTsxResult] = useState<{ tsx: string; familyName?: string } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [selectedSite, setSelectedSite] = useState<string | null>(null)
  const [projectList, setProjectList] = useState<Array<{id: string; name: string; canvas_json: any[]; created_at: string}>>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  // Auto-crawl state
  const [crawlQueueCount, setCrawlQueueCount] = useState(0)
  const [crawlDoneCount, setCrawlDoneCount] = useState(0)
  const [crawlActive, setCrawlActive] = useState(false)
  const [crawlCurrentUrl, setCrawlCurrentUrl] = useState<string | null>(null)
  const [crawlUrls, setCrawlUrls] = useState('')
  const [crawlExpanded, setCrawlExpanded] = useState(false)
  const [crawlSubmitting, setCrawlSubmitting] = useState(false)
  const [crawlStep, setCrawlStep] = useState(1)
  const [keywordSearch, setKeywordSearch] = useState('')
  const [keywordSearching, setKeywordSearching] = useState(false)
  const [keywordResult, setKeywordResult] = useState<{ keywords: string[]; urls: string[] } | null>(null)
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set())
  const [newProjectName, setNewProjectName] = useState('')
  const [showNewProject, setShowNewProject] = useState(false)

  // Persist canvas to localStorage + Supabase project (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ version: CANVAS_STORAGE_VERSION, canvas }))
      // プロジェクトが選択されていれば自動保存
      if (activeProjectId) {
        fetch(`/api/projects/${activeProjectId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ canvas_json: canvas })
        }).catch(() => {})
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [canvas])

  // Load projects on mount
  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then(d => setProjectList(d.projects || [])).catch(() => {})
  }, [])

  // Load all sections from library on mount
  useEffect(() => {
    fetch('/api/library?limit=500&sort=newest')
      .then(r => r.ok ? r.json() : { sections: [] })
      .then(data => {
        const libSections: SourceSection[] = data.sections || []
        setSections(prev => {
          const seen = new Set(prev.map(s => s.id))
          const next = [...prev]
          for (const s of libSections) {
            if (!seen.has(s.id)) {
              seen.add(s.id)
              next.push(s)
            }
          }
          return next
        })
      })
      .catch(() => {})
  }, [])
  // Cycle crawl steps 1→2→3→4 every 8 seconds while active
  useEffect(() => {
    if (!crawlActive) { setCrawlStep(1); return }
    const interval = setInterval(() => {
      setCrawlStep(prev => prev >= 3 ? 1 : prev + 1)
    }, 6000)
    return () => clearInterval(interval)
  }, [crawlActive])

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

  const handleKeywordSearch = useCallback(async () => {
    if (!keywordSearch.trim()) return
    setKeywordSearching(true)
    setKeywordResult(null)
    setSelectedUrls(new Set())
    try {
      const res = await fetch('/api/keyword-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: keywordSearch.trim() })
      })
      if (res.ok) {
        const data = await res.json()
        setKeywordResult({ keywords: data.expandedKeywords, urls: data.urls })
        // デフォルトで全選択
        setSelectedUrls(new Set(data.urls))
      }
    } catch {}
    setKeywordSearching(false)
  }, [keywordSearch])

  const handleAddSelectedToQueue = useCallback(async () => {
    if (selectedUrls.size === 0) return
    try {
      const res = await fetch('/api/crawl-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: [...selectedUrls] })
      })
      if (res.ok) {
        const data = await res.json()
        setCrawlQueueCount(data.queue?.length || 0)
        setCrawlActive(data.active || false)
        setKeywordResult(null)
        setSelectedUrls(new Set())
      }
    } catch {}
  }, [selectedUrls])

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
          // loadingは維持（ターミナル画面で「抽出結果を見る」ボタンを表示）
          setJobStatus(null)
          setView('editor')
        } else if (job.status === 'failed') {
          stopPolling()
          setError(job.error_message || '取得に失敗しました')
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
    setJobStatus('準備中...')
    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, genre, tags })
      })
      if (!res.ok) {
        let message = 'ジョブの作成に失敗しました'
        try {
          const data = await res.json()
          message = data.error || message
        } catch {}
        throw new Error(message)
      }
      const { jobId } = await res.json()
      setJobStatus('処理待ち...')
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

  const handleNewProject = async (name: string) => {
    try {
      const res = await fetch('/api/projects', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name}) })
      if (res.ok) {
        const { project } = await res.json()
        setProjectList(prev => [project, ...prev])
        // Save current canvas to old project before switching
        if (activeProjectId) {
          await fetch(`/api/projects/${activeProjectId}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({canvas_json: canvas}) })
        }
        setActiveProjectId(project.id)
        setCanvas([])
        setView('editor')
      }
    } catch {}
  }

  const handleSwitchProject = async (projectId: string) => {
    // Save current
    if (activeProjectId) {
      await fetch(`/api/projects/${activeProjectId}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({canvas_json: canvas}) }).catch(() => {})
    }
    const target = projectList.find(p => p.id === projectId)
    if (target) {
      setCanvas(target.canvas_json || [])
      setActiveProjectId(projectId)
      setView('editor')
    }
  }

  const handleSaveProject = async () => {
    if (!activeProjectId) return
    await fetch(`/api/projects/${activeProjectId}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({canvas_json: canvas}) }).catch(() => {})
    alert('保存しました')
  }

  const handleDeleteProject = async (projectId: string) => {
    await fetch(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => {})
    setProjectList(prev => prev.filter(p => p.id !== projectId))
    if (activeProjectId === projectId) {
      setActiveProjectId(null)
      setCanvas([])
    }
  }

  const filteredSections = selectedSite
    ? sections.filter(s => s.source_sites?.normalized_domain === selectedSite)
    : sections

  const canvasItems = canvas.map(c => ({
    canvas: c,
    section: sections.find(s => s.id === c.sectionId)!
  })).filter(c => c.section)

  return (
    <div className="app">
      <ErrorBoundary>
      <aside className="sidebar">
        <div className="sidebar-logo">
          <h1>PARTCOPY</h1>
          <span>サイト構造解析ツール</span>
        </div>
        <nav className="sidebar-nav">
          <span className="sidebar-nav-label">メニュー</span>
          <button className={`sidebar-nav-btn ${view === 'dashboard' ? 'active' : ''}`} onClick={() => setView('dashboard')}>
            ダッシュボード
          </button>
          <button className={`sidebar-nav-btn ${view === 'editor' ? 'active' : ''}`} onClick={() => setView('editor')}>
            編集
          </button>
          <button className={`sidebar-nav-btn ${view === 'library' ? 'active' : ''}`} onClick={() => setView('library')}>
            ライブラリ
          </button>
          <button className={`sidebar-nav-btn ${view === 'preview' ? 'active' : ''}`} onClick={() => setView('preview')}>
            プレビュー
          </button>
        </nav>
        <div className="sidebar-projects">
          <span className="sidebar-nav-label">プロジェクト</span>
          {projectList.map(p => (
            <button
              key={p.id}
              className={`sidebar-project-btn ${p.id === activeProjectId ? 'active' : ''}`}
              onClick={() => handleSwitchProject(p.id)}
            >
              <span>{p.name}</span>
              {p.id === activeProjectId && <span className="sidebar-site-count">編集中</span>}
              {p.id !== activeProjectId && (
                <span className="sidebar-project-delete" onClick={e => { e.stopPropagation(); handleDeleteProject(p.id) }}>×</span>
              )}
            </button>
          ))}
          {showNewProject ? (
            <div className="sidebar-project-input">
              <input
                type="text"
                placeholder="プロジェクト名"
                value={newProjectName}
                onChange={e => setNewProjectName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newProjectName.trim()) {
                    handleNewProject(newProjectName.trim())
                    setNewProjectName('')
                    setShowNewProject(false)
                  }
                  if (e.key === 'Escape') setShowNewProject(false)
                }}
                autoFocus
              />
              <button onClick={() => {
                if (newProjectName.trim()) {
                  handleNewProject(newProjectName.trim())
                  setNewProjectName('')
                  setShowNewProject(false)
                }
              }}>作成</button>
            </div>
          ) : (
            <button className="sidebar-project-new" onClick={() => setShowNewProject(true)}>
              + 新規プロジェクト
            </button>
          )}
        </div>
        <div className="sidebar-stats">
          <div className="sidebar-stat">パーツ <strong>{sections.length}</strong></div>
          <div className="sidebar-stat">サイト <strong>{sourceCount}</strong></div>
          <div className="sidebar-stat">Canvas <strong>{canvas.length}</strong></div>
        </div>
      </aside>

      <main className="main-content">

      {view === 'dashboard' && <Dashboard sections={sections} canvas={canvas} onNavigate={(v) => setView(v as any)} onExtract={(url) => handleExtract(url, '', [])} extractLoading={loading} />}

      {view === 'editor' && (
        <div className="editor-layout">
          <PartsPanel sections={filteredSections} onAdd={addToCanvas} onRemove={removeSection} onViewTsx={handleViewTsx} />
          <Canvas items={canvasItems} onRemove={removeFromCanvas} onMove={moveBlock} onViewTsx={handleViewTsx} onExportZip={handleExportZip} exporting={exporting} onSaveProject={activeProjectId ? handleSaveProject : undefined} onNewProject={() => setShowNewProject(true)} />
        </div>
      )}

      {view === 'preview' && <Preview items={canvasItems} onExportZip={handleExportZip} exporting={exporting} />}

      {view === 'library' && <Library onAddToCanvas={addSavedToCanvas} />}

      {tsxResult && (
        <TsxModal
          tsx={tsxResult.tsx}
          familyName={tsxResult.familyName}
          onClose={() => setTsxResult(null)}
        />
      )}

      {loading && (
        <div className="loading-overlay">
          <div className="loading-terminal">
            <div className="terminal-header">
              <span className="terminal-dot red" />
              <span className="terminal-dot yellow" />
              <span className="terminal-dot green" />
              <span className="terminal-title">PARTCOPY — 解析中</span>
            </div>
            <div className="terminal-body">
              <div className="terminal-line typing-1">
                <span className="terminal-prompt">$</span> サイトに接続しています...
              </div>
              <div className="terminal-line typing-2">
                <span className="terminal-prompt">$</span> HTML / CSS / 画像 / フォントをダウンロード中...
              </div>
              <div className="terminal-line typing-3">
                <span className="terminal-prompt">$</span> セクションを検出しています...
              </div>
              <div className="terminal-line typing-4">
                <span className="terminal-prompt">$</span> パーツを分類しています...
              </div>
              <div className="terminal-line typing-5">
                <span className="terminal-prompt">&gt;</span> Claude が TSX に変換中...
              </div>
              {jobStatus && (
                <div className="terminal-status">
                  <span className="terminal-cursor" />
                  {jobStatus}
                </div>
              )}
              {!jobStatus && sections.length > 0 && (
                <>
                  <div className="terminal-done">
                    <span>✓ 抽出完了 — {sections.length} パーツ取得</span>
                  </div>
                  <div className="terminal-results">
                    {sections.slice(-10).map((s, i) => (
                      <div key={s.id} className="terminal-result-line" style={{ animationDelay: `${i * 0.15}s` }}>
                        <span className="terminal-prompt">→</span>
                        <span className="result-family">[{s.block_family}]</span>
                        <span className="result-domain">{s.source_sites?.normalized_domain || ''}</span>
                        {s.tsx_code_storage_path && <span className="result-tsx">TSX</span>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            {!jobStatus && sections.length > 0 && (
              <div className="terminal-footer">
                <button className="terminal-view-btn" onClick={() => setLoading(false)}>
                  抽出結果を見る →
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      </main>
      </ErrorBoundary>
    </div>
  )
}
