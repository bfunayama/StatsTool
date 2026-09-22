import { useEffect, useState } from 'react'
import './App.css'
import { getDataset, type DatasetMeta } from './api'
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

  useEffect(() => {
    if (!datasetId) {
      setMeta(null)
      localStorage.removeItem(LAST_DATASET_KEY)
      return
    }
    localStorage.setItem(LAST_DATASET_KEY, datasetId)
    getDataset(datasetId)
      .then(setMeta)
      .catch((err) => {
        // The remembered dataset may have been deleted — fall back to the list.
        setError(err instanceof Error ? err.message : 'Failed to load dataset')
        setDatasetId(null)
      })
  }, [datasetId])

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
            {meta.source_filename} · {meta.n_rows} rows · {meta.n_cols} columns
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
            <button onClick={() => setDatasetId(null)}>← Datasets</button>
          </div>

          {tab === 'variables' && (
            <VariableEditor meta={meta} onChanged={setMeta} />
          )}
          {tab === 'filters' && (
            <FiltersManager meta={meta} onChanged={setMeta} />
          )}
          {tab === 'crosstabs' && <CrosstabView meta={meta} onChanged={setMeta} />}
          {tab === 'data' && (
            <DataPreview datasetId={meta.id} filterId={dataFilter || undefined} />
          )}
        </div>
      )}
    </div>
  )
}

export default App
