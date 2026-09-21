import { useEffect, useState } from 'react'
import './App.css'
import { getDataset, type DatasetMeta } from './api'
import { DatasetImport } from './components/DatasetImport'
import { DataPreview } from './components/DataPreview'
import { VariableEditor } from './components/VariableEditor'

type Tab = 'variables' | 'data'

function App() {
  const [datasetId, setDatasetId] = useState<string | null>(null)
  const [meta, setMeta] = useState<DatasetMeta | null>(null)
  const [tab, setTab] = useState<Tab>('variables')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!datasetId) {
      setMeta(null)
      return
    }
    getDataset(datasetId)
      .then(setMeta)
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load dataset'),
      )
  }, [datasetId])

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
              className={tab === 'data' ? 'tab active' : 'tab'}
              onClick={() => setTab('data')}
            >
              Data
            </button>
            <span className="spacer" />
            <button onClick={() => setDatasetId(null)}>← Datasets</button>
          </div>

          {tab === 'variables' && (
            <VariableEditor meta={meta} onChanged={setMeta} />
          )}
          {tab === 'data' && <DataPreview datasetId={meta.id} />}
        </div>
      )}
    </div>
  )
}

export default App
