import { useEffect, useMemo, useState } from 'react'
import {
  runCrosstab,
  type CrosstabResponse,
  type CrosstabRowSpec,
  type DatasetMeta,
} from '../api'

interface Props {
  meta: DatasetMeta
}

// Encode a row choice as "v:<name>" (variable) or "q:<id>" (grouped variable).
function decodeRow(value: string): CrosstabRowSpec | null {
  if (value.startsWith('v:')) return { kind: 'variable', ref: value.slice(2) }
  if (value.startsWith('q:')) return { kind: 'question', ref: value.slice(2) }
  return null
}

export function CrosstabView({ meta }: Props) {
  const memberless = useMemo(
    () => meta.variables.filter((v) => !v.question_id),
    [meta.variables],
  )
  const multiQuestions = useMemo(
    () => (meta.questions ?? []).filter((q) => q.kind === 'multi'),
    [meta.questions],
  )

  const [rowValue, setRowValue] = useState('')
  const [colValue, setColValue] = useState('')
  const [filterId, setFilterId] = useState('')
  const [result, setResult] = useState<CrosstabResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const row = decodeRow(rowValue)
    if (!row || !colValue) {
      setResult(null)
      setError(null)
      return
    }
    let ignore = false
    setLoading(true)
    setError(null)
    runCrosstab(meta.id, row, colValue, filterId || null)
      .then((res) => {
        if (!ignore) setResult(res)
      })
      .catch((err) => {
        if (!ignore) {
          setResult(null)
          setError(err instanceof Error ? err.message : 'Crosstab failed')
        }
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
  }, [meta.id, rowValue, colValue, filterId])

  return (
    <div>
      <div className="ct-controls">
        <label className="field">
          Row
          <select value={rowValue} onChange={(e) => setRowValue(e.target.value)}>
            <option value="">Choose a variable…</option>
            {multiQuestions.length > 0 && (
              <optgroup label="Grouped (Pick any)">
                {multiQuestions.map((q) => (
                  <option key={q.id} value={`q:${q.id}`}>
                    {q.label}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Variables">
              {memberless.map((v) => (
                <option key={v.name} value={`v:${v.name}`}>
                  {v.label}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="field">
          Column
          <select value={colValue} onChange={(e) => setColValue(e.target.value)}>
            <option value="">Choose a variable…</option>
            {memberless.map((v) => (
              <option key={v.name} value={v.name}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Filter
          <select value={filterId} onChange={(e) => setFilterId(e.target.value)}>
            <option value="">None (all respondents)</option>
            {meta.filters.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        {loading && <span className="muted">Computing…</span>}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Each cell shows the count and the column % (based on valid responses).
      </p>

      {error && <p className="error">{error}</p>}

      {result && (
        <div className="table-scroll">
          <table className="grid crosstab">
            <thead>
              <tr>
                <th />
                {result.columns.map((c) => (
                  <th key={c.label} className="ct-colhead">
                    {c.label}
                  </th>
                ))}
              </tr>
              <tr>
                <th className="ct-base-label">Base</th>
                {result.columns.map((c) => (
                  <th key={c.label} className="ct-base">
                    {c.base}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.row_labels.map((label, ri) => (
                <tr key={label}>
                  <th className="ct-rowhead">{label}</th>
                  {result.cells[ri].map((cell, ci) => (
                    <td key={result.columns[ci].label} className="ct-cell">
                      <span className="ct-count">{cell.count}</span>
                      {cell.column_pct !== null && (
                        <span className="ct-pct">
                          {cell.column_pct.toFixed(1)}%
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!result && !error && !loading && (
        <p className="muted">Choose a row and a column variable to build a table.</p>
      )}
    </div>
  )
}
