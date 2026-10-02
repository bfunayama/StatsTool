import { useEffect, useRef, useState } from 'react'
import {
  listDatasets,
  uploadDataset,
  type DatasetSummary,
  type SourceFormat,
} from '../api'

interface Props {
  onOpen: (datasetId: string) => void
}

export function DatasetImport({ onOpen }: Props) {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [format, setFormat] = useState<SourceFormat>('medallia')
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    listDatasets().then(setDatasets).catch(() => setDatasets([]))
  }, [])

  async function handleFile(file: File) {
    setBusy(true)
    setError(null)
    try {
      const meta = await uploadDataset(file, format)
      onOpen(meta.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel">
      <h2>Import survey data</h2>
      <p className="muted">
        Load a .csv or tab-separated export. UTF-16 files (e.g. from Medallia)
        are handled automatically.
      </p>

      <fieldset className="import-format">
        <legend>File type</legend>
        <label className="ct-check">
          <input
            type="radio"
            name="source-format"
            checked={format === 'medallia'}
            onChange={() => setFormat('medallia')}
          />
          Medallia export
          <span className="muted"> — standard, one column per question</span>
        </label>
        <label className="ct-check">
          <input
            type="radio"
            name="source-format"
            checked={format === 'askable'}
            onChange={() => setFormat('askable')}
          />
          Askable export
          <span className="muted">
            {' '}
            — block layout (Unmoderated or Survey), reshaped on import
          </span>
        </label>
      </fieldset>

      <input
        ref={fileInput}
        type="file"
        accept=".csv,.tsv,.txt"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFile(file)
          e.target.value = ''
        }}
      />
      <button
        className="primary"
        disabled={busy}
        onClick={() => fileInput.current?.click()}
      >
        {busy ? 'Importing…' : 'Choose file to import'}
      </button>
      {error && <p className="error">{error}</p>}

      <h3 style={{ marginTop: '2rem' }}>Recent datasets</h3>
      {datasets.length === 0 ? (
        <p className="muted">No datasets yet.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>File</th>
              <th>Rows</th>
              <th>Columns</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {datasets.map((d) => (
              <tr key={d.id}>
                <td>{d.source_filename}</td>
                <td>{d.n_rows}</td>
                <td>{d.n_cols}</td>
                <td>
                  <button onClick={() => onOpen(d.id)}>Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
