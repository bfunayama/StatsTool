import { useEffect, useState } from 'react'
import { getPreview, type PreviewResponse } from '../api'

interface Props {
  datasetId: string
}

export function DataPreview({ datasetId }: Props) {
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setPreview(null)
    setError(null)
    getPreview(datasetId, 50)
      .then(setPreview)
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load preview'),
      )
  }, [datasetId])

  if (error) return <p className="error">{error}</p>
  if (!preview) return <p className="muted">Loading preview…</p>

  return (
    <div>
      <p className="muted">
        Showing first {preview.rows.length} of {preview.total_rows} rows.
      </p>
      <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              {preview.columns.map((col) => (
                <th key={col}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, i) => (
              <tr key={i}>
                {preview.columns.map((col) => (
                  <td key={col}>{formatCell(row[col])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function formatCell(value: string | number | null): string {
  if (value === null || value === undefined) return ''
  return String(value)
}
