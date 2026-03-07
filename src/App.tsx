import React, { useState, useCallback } from 'react'
import { ExtractedBlock, CanvasBlock, SavedPart } from './types'
import { URLInput } from './components/URLInput'
import { PartsPanel } from './components/PartsPanel'
import { Canvas } from './components/Canvas'
import { Preview } from './components/Preview'
import { ExportModal } from './components/ExportModal'
import { Library } from './components/Library'
import './styles.css'

type View = 'editor' | 'preview' | 'library'

export default function App() {
  const [parts, setParts] = useState<ExtractedBlock[]>([])
  const [canvas, setCanvas] = useState<CanvasBlock[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('editor')
  const [showExport, setShowExport] = useState(false)
  const [currentGenre, setCurrentGenre] = useState('')
  const [currentTags, setCurrentTags] = useState<string[]>([])
  const [saveStatus, setSaveStatus] = useState<string | null>(null)

  const handleExtract = useCallback(async (url: string, genre: string, tags: string[]) => {
    setLoading(true)
    setError(null)
    setCurrentGenre(genre)
    setCurrentTags(tags)
    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Extraction failed')
      }
      const data = await res.json()
      const partsWithMeta = data.parts.map((p: any) => ({
        ...p,
        genre,
        tags
      }))
      setParts(prev => [...prev, ...partsWithMeta])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const addToCanvas = useCallback((blockId: string) => {
    setCanvas(prev => [...prev, { id: crypto.randomUUID(), blockId, order: prev.length }])
  }, [])

  const addSavedPartToCanvas = useCallback((part: SavedPart) => {
    // Convert SavedPart to ExtractedBlock-like and add
    const block: ExtractedBlock = {
      id: part.id + '-' + Date.now(),
      type: part.type as any,
      confidence: part.confidence,
      html: part.html,
      css: '',
      stylesheetUrls: [],
      textContent: part.textContent,
      tagName: part.tagName,
      position: { top: 0, left: 0, width: 0, height: 0 },
      meta: part.meta as any,
      sourceUrl: part.sourceUrl,
      thumbnail: part.thumbnail,
      genre: part.genre,
      tags: part.tags
    }
    setParts(prev => [...prev, block])
    setCanvas(prev => [...prev, { id: crypto.randomUUID(), blockId: block.id, order: prev.length }])
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
      return next.map((c, i) => ({ ...c, order: i }))
    })
  }, [])

  const removePart = useCallback((partId: string) => {
    setParts(prev => prev.filter(p => p.id !== partId))
    setCanvas(prev => prev.filter(c => c.blockId !== partId))
  }, [])

  const handleSaveToLibrary = useCallback(async () => {
    if (parts.length === 0) return
    setSaveStatus('saving...')
    try {
      const res = await fetch('/api/library/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts,
          genre: currentGenre,
          tags: currentTags
        })
      })
      const data = await res.json()
      setSaveStatus(`${data.saved} parts saved!`)
      setTimeout(() => setSaveStatus(null), 3000)
    } catch {
      setSaveStatus('Save failed')
      setTimeout(() => setSaveStatus(null), 3000)
    }
  }, [parts, currentGenre, currentTags])

  const canvasBlocks = canvas.map(c => ({
    canvas: c,
    block: parts.find(p => p.id === c.blockId)!
  })).filter(c => c.block)

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo">
          <h1>PARTCOPY</h1>
          <span className="app-tagline">URL to Parts Builder</span>
        </div>
        <div className="app-actions">
          <button
            className={`view-btn ${view === 'editor' ? 'active' : ''}`}
            onClick={() => setView('editor')}
          >
            Editor
          </button>
          <button
            className={`view-btn ${view === 'library' ? 'active' : ''}`}
            onClick={() => setView('library')}
          >
            Library
          </button>
          <button
            className={`view-btn ${view === 'preview' ? 'active' : ''}`}
            onClick={() => setView('preview')}
          >
            Preview
          </button>
          {parts.length > 0 && (
            <button className="save-lib-btn" onClick={handleSaveToLibrary}>
              {saveStatus || 'Save to Library'}
            </button>
          )}
          {canvas.length > 0 && (
            <button className="export-btn" onClick={() => setShowExport(true)}>
              Export HTML
            </button>
          )}
        </div>
      </header>

      {view !== 'library' && (
        <URLInput onSubmit={handleExtract} loading={loading} error={error} />
      )}

      {view === 'editor' && (
        <div className="editor-layout">
          <PartsPanel
            parts={parts}
            onAdd={addToCanvas}
            onRemove={removePart}
          />
          <Canvas
            blocks={canvasBlocks}
            onRemove={removeFromCanvas}
            onMove={moveBlock}
          />
        </div>
      )}

      {view === 'preview' && <Preview blocks={canvasBlocks} />}

      {view === 'library' && <Library onAddToCanvas={addSavedPartToCanvas} />}

      {showExport && (
        <ExportModal
          blocks={canvasBlocks}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  )
}
