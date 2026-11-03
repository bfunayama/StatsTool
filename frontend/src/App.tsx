import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import {
  getDataset,
  projectExportUrl,
  replaceMeta,
  type DatasetMeta,
} from './api'
import { useBackdropDismiss } from './useBackdropDismiss'
import { DatasetImport } from './components/DatasetImport'
import { DataPreview } from './components/DataPreview'
import { CrosstabView } from './components/CrosstabView'
import { FiltersManager } from './components/FiltersManager'
import { VariableEditor } from './components/VariableEditor'

type Tab = 'variables' | 'filters' | 'crosstabs' | 'data'

const LAST_DATASET_KEY = 'statstool.lastDataset'
const LAST_TAB_KEY = 'statstool.lastTab'

function App() {
  const [datasetId, setDatasetId] = useState<string | null>(
    () => localStorage.getItem(LAST_DATASET_KEY),
  )
  const [meta, setMeta] = useState<DatasetMeta | null>(null)
  const [tab, setTab] = useState<Tab>(
    () => (localStorage.getItem(LAST_TAB_KEY) as Tab | null) ?? 'variables',
  )
  const [dataFilter, setDataFilter] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveIncludeData, setSaveIncludeData] = useState(true)
  const backdrop = useBackdropDismiss()

  // Global, session-only undo/redo over whole-analysis snapshots. Edits route
  // through recordAndSet; bursts within COALESCE_MS collapse to one step.
  const metaRef = useRef<DatasetMeta | null>(null)
  const undoRef = useRef<DatasetMeta[]>([])
  const redoRef = useRef<DatasetMeta[]>([])
  const lastChangeRef = useRef(0)
  const [undoLen, setUndoLen] = useState(0)
  const [redoLen, setRedoLen] = useState(0)
  const COALESCE_MS = 500

  const syncLens = useCallback(() => {
    setUndoLen(undoRef.current.length)
    setRedoLen(redoRef.current.length)
  }, [])

  const recordAndSet = useCallback(
    (next: DatasetMeta) => {
      const cur = metaRef.current
      const now = Date.now()
      if (cur && cur.id === next.id) {
        if (now - lastChangeRef.current > COALESCE_MS) {
          undoRef.current.push(cur)
          if (undoRef.current.length > 100) undoRef.current.shift()
          redoRef.current = []
        }
      } else {
        undoRef.current = []
        redoRef.current = []
      }
      lastChangeRef.current = now
      metaRef.current = next
      setMeta(next)
      syncLens()
    },
    [syncLens],
  )

  const undo = useCallback(() => {
    const cur = metaRef.current
    if (!cur || undoRef.current.length === 0) return
    const prev = undoRef.current.pop() as DatasetMeta
    redoRef.current.push(cur)
    lastChangeRef.current = 0
    metaRef.current = prev
    setMeta(prev)
    syncLens()
    replaceMeta(prev.id, prev).catch(() => {})
  }, [syncLens])

  const redo = useCallback(() => {
    const cur = metaRef.current
    if (!cur || redoRef.current.length === 0) return
    const next = redoRef.current.pop() as DatasetMeta
    undoRef.current.push(cur)
    lastChangeRef.current = 0
    metaRef.current = next
    setMeta(next)
    syncLens()
    replaceMeta(next.id, next).catch(() => {})
  }, [syncLens])

  // Keyboard: ⌘Z / ⌘⇧Z (and Ctrl on Windows). Let native undo win inside fields.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()
      const isUndo = key === 'z' && !e.shiftKey
      const isRedo = (key === 'z' && e.shiftKey) || key === 'y'
      if (!isUndo && !isRedo) return
      const el = document.activeElement as HTMLElement | null
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable)
      )
        return
      e.preventDefault()
      if (isRedo) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  function doSave() {
    if (!meta) return
    const a = document.createElement('a')
    a.href = projectExportUrl(meta.id, saveIncludeData)
    a.download = `${meta.name || meta.source_filename}.statstool`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setSaveOpen(false)
  }

  useEffect(() => {
    if (!datasetId) {
      setMeta(null)
      localStorage.removeItem(LAST_DATASET_KEY)
      return
    }
    localStorage.setItem(LAST_DATASET_KEY, datasetId)
    getDataset(datasetId)
      .then((m) => {
        // A freshly loaded dataset starts a clean history.
        undoRef.current = []
        redoRef.current = []
        lastChangeRef.current = 0
        metaRef.current = m
        setMeta(m)
        syncLens()
      })
      .catch((err) => {
        // The remembered dataset may have been deleted — fall back to the list.
        setError(err instanceof Error ? err.message : 'Failed to load dataset')
        setDatasetId(null)
      })
  }, [datasetId, syncLens])

  useEffect(() => {
    localStorage.setItem(LAST_TAB_KEY, tab)
  }, [tab])

  return (
    <div className="app">
      <header className="app-header">
        <h1
          onClick={() => setDatasetId(null)}
          style={{ cursor: 'pointer' }}
          title="Back to datasets"
        >
          StatsTool
        </h1>
        {meta && (
          <span className="muted">
            {meta.name || meta.source_filename} · {meta.n_rows} rows ·{' '}
            {meta.n_cols} columns
          </span>
        )}
      </header>

      {error && <p className="error">{error}</p>}

      {!datasetId && (
        <DatasetImport
          onOpen={(id) => {
            setError(null)
            setTab('variables')
            setDatasetId(id)
          }}
        />
      )}

      {datasetId && meta && (
        <div className="panel">
          <div className="tabs">
            <button
              className={tab === 'variables' ? 'tab active' : 'tab'}
              onClick={() => setTab('variables')}
            >
              Variables
            </button>
            <button
              className={tab === 'filters' ? 'tab active' : 'tab'}
              onClick={() => setTab('filters')}
            >
              Filters
            </button>
            <button
              className={tab === 'crosstabs' ? 'tab active' : 'tab'}
              onClick={() => setTab('crosstabs')}
            >
              Crosstabs
            </button>
            <button
              className={tab === 'data' ? 'tab active' : 'tab'}
              onClick={() => setTab('data')}
            >
              Data
            </button>
            <span className="spacer" />
            <button onClick={undo} disabled={undoLen === 0} title="Undo (⌘Z)">
              ↶ Undo
            </button>
            <button onClick={redo} disabled={redoLen === 0} title="Redo (⌘⇧Z)">
              ↷ Redo
            </button>
            {tab === 'data' && meta.filters.length > 0 && (
              <label className="muted" style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                Filter:
                <select
                  value={dataFilter}
                  onChange={(e) => setDataFilter(e.target.value)}
                >
                  <option value="">None (all respondents)</option>
                  {meta.filters.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button onClick={() => setSaveOpen(true)}>Download</button>
            <button onClick={() => setDatasetId(null)}>← Datasets</button>
          </div>

          {tab === 'variables' && (
            <VariableEditor meta={meta} onChanged={recordAndSet} />
          )}
          {tab === 'filters' && (
            <FiltersManager meta={meta} onChanged={recordAndSet} />
          )}
          {tab === 'crosstabs' && (
            <CrosstabView meta={meta} onChanged={recordAndSet} />
          )}
          {tab === 'data' && (
            <DataPreview datasetId={meta.id} filterId={dataFilter || undefined} />
          )}
        </div>
      )}

      {saveOpen && meta && (
        <div className="modal-backdrop" {...backdrop(() => setSaveOpen(false))}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Save project file</h3>
            </div>
            <p>
              Download “{meta.name || meta.source_filename}” as a .statstool
              file you can reopen or share.
            </p>
            <label className="ct-check">
              <input
                type="checkbox"
                checked={saveIncludeData}
                onChange={(e) => setSaveIncludeData(e.target.checked)}
              />
              Include the raw data
              <span className="muted">
                {' '}
                — makes the file fully portable (larger). Uncheck for an
                analysis-only template.
              </span>
            </label>
            <div className="modal-actions">
              <button onClick={() => setSaveOpen(false)}>Cancel</button>
              <button className="primary" onClick={doSave}>
                Save file
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
