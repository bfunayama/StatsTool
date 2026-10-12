import { useEffect, useState } from 'react'
import {
  getCombinations,
  previewWeight,
  saveWeight,
  type DatasetMeta,
  type Variable,
  type WeightPreview,
  type WeightRim,
} from '../api'
import { useBackdropDismiss } from '../useBackdropDismiss'

interface Props {
  datasetId: string
  variables: Variable[]
  initial?: Variable | null // an existing weight variable to edit
  onClose: () => void
  onSaved: (meta: DatasetMeta) => void
}

const KEY_SEP = '\u0001'

// A rim's targets are valid when they total 100% — overall for a joint rim, or
// within each column category when the rim uses the "column" basis.
function rimValid(rim: WeightRim): boolean {
  if (rim.cells.length === 0) return true
  if (rim.basis === 'column' && rim.variables.length === 2) {
    const totals = new Map<string, number>()
    for (const c of rim.cells)
      totals.set(c.values[1], (totals.get(c.values[1]) || 0) + (c.percent || 0))
    return [...totals.values()].every((t) => Math.abs(t - 100) <= 0.5)
  }
  const sum = rim.cells.reduce((a, c) => a + (c.percent || 0), 0)
  return Math.abs(sum - 100) <= 0.5
}

export function WeightDialog({ datasetId, variables, initial, onClose, onSaved }: Props) {
  const [label, setLabel] = useState(initial?.label ?? 'Weight')
  const [rims, setRims] = useState<WeightRim[]>(initial?.weighting?.rims ?? [])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<WeightPreview | null>(null)
  const backdrop = useBackdropDismiss()

  // Variables you can weight on (not weights, not grouped-question members, not hidden).
  const weightable = variables.filter(
    (v) => v.type !== 'weight' && !v.question_id && !v.hidden,
  )
  const labelFor = (name: string) =>
    variables.find((v) => v.name === name)?.label ?? name

  // Load observed combinations for a rim, keeping any target %s already set.
  async function reloadCells(rim: WeightRim) {
    if (rim.variables.length === 0) {
      setRims((prev) =>
        prev.map((r) => (r.id === rim.id ? { ...r, cells: [] } : r)),
      )
      return
    }
    setBusy(rim.id)
    setError(null)
    try {
      const combos = await getCombinations(
        datasetId,
        rim.variables,
        rim.missing === 'category',
      )
      const existing = new Map(
        rim.cells.map((c) => [c.values.join(KEY_SEP), c.percent]),
      )
      const cells = combos.map((c) => ({
        values: c.values,
        percent: existing.get(c.values.join(KEY_SEP)) ?? c.percent,
      }))
      setRims((prev) =>
        prev.map((r) => (r.id === rim.id ? { ...r, cells } : r)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load categories')
    } finally {
      setBusy(null)
    }
  }

  // For an existing weight, refresh its rims' cells once on open.
  useEffect(() => {
    for (const rim of initial?.weighting?.rims ?? []) reloadCells(rim)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live weighting-efficiency estimate whenever the rims/targets are valid.
  useEffect(() => {
    const ready =
      rims.length > 0 &&
      rims.every(
        (r) => r.variables.length > 0 && r.cells.length > 0 && rimValid(r),
      )
    if (!ready) {
      setPreview(null)
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      previewWeight(datasetId, { rims, max_iter: 50 }, label.trim() || 'Weight')
        .then((p) => {
          if (!cancelled) setPreview(p)
        })
        .catch(() => {
          if (!cancelled) setPreview(null)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [datasetId, label, rims])

  function addRim() {
    setRims([
      ...rims,
      {
        id: crypto.randomUUID(),
        variables: [],
        missing: 'exclude',
        basis: 'overall',
        cells: [],
      },
    ])
  }

  function removeRim(id: string) {
    setRims(rims.filter((r) => r.id !== id))
  }

  function addRimVariable(rim: WeightRim, name: string) {
    if (!name || rim.variables.includes(name)) return
    const next = { ...rim, variables: [...rim.variables, name] }
    setRims((prev) => prev.map((r) => (r.id === rim.id ? next : r)))
    reloadCells(next)
  }

  function removeRimVariable(rim: WeightRim, name: string) {
    const next = { ...rim, variables: rim.variables.filter((v) => v !== name) }
    setRims((prev) => prev.map((r) => (r.id === rim.id ? next : r)))
    reloadCells(next)
  }

  function setMissing(rim: WeightRim, missing: 'exclude' | 'category') {
    const next = { ...rim, missing }
    setRims((prev) => prev.map((r) => (r.id === rim.id ? next : r)))
    reloadCells(next)
  }

  function setBasis(rim: WeightRim, basis: 'overall' | 'column') {
    setRims((prev) => prev.map((r) => (r.id === rim.id ? { ...r, basis } : r)))
  }

  function setPercent(rimId: string, index: number, percent: number) {
    setRims((prev) =>
      prev.map((r) =>
        r.id === rimId
          ? {
              ...r,
              cells: r.cells.map((c, i) => (i === index ? { ...c, percent } : c)),
            }
          : r,
      ),
    )
  }

  async function save() {
    const trimmed = label.trim()
    if (!trimmed) {
      setError('Give the weight a name.')
      return
    }
    if (rims.length === 0 || rims.some((r) => r.variables.length === 0)) {
      setError('Each rim needs at least one variable.')
      return
    }
    const bad = rims.find((r) => r.cells.length > 0 && !rimValid(r))
    if (bad) {
      setError(
        bad.basis === 'column' && bad.variables.length === 2
          ? `Each ${labelFor(bad.variables[1])} column's targets must total 100% before saving.`
          : `Targets for ${bad.variables.join(' × ')} must add to 100% before saving.`,
      )
      return
    }
    setSaving(true)
    setError(null)
    try {
      const meta = await saveWeight(
        datasetId,
        { rims, max_iter: 50 },
        trimmed,
        initial?.name ?? null,
      )
      onSaved(meta)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save weight')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" {...backdrop(onClose)}>
      <div
        className="modal weight-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{initial ? 'Edit weight' : 'New weight'}</h3>
          {preview && (
            <span className="weight-efficiency" title="Effective sample ÷ total sample">
              Weighting efficiency:{' '}
              <strong>{preview.efficiency.toFixed(1)}%</strong>
              <span className="muted">
                {' '}
                (effective n {Math.round(preview.effective_sample)} of{' '}
                {Math.round(preview.total_sample)})
              </span>
            </span>
          )}
          <button className="expand" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <label className="field" style={{ marginBottom: '0.75rem' }}>
          Name
          <input
            className="cell-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <div className="weight-rims">
          {rims.map((rim) => {
            const sum = rim.cells.reduce((a, c) => a + (c.percent || 0), 0)
            const perColumn =
              rim.basis === 'column' && rim.variables.length === 2
            const offTarget = rim.cells.length > 0 && !rimValid(rim)
            return (
              <div key={rim.id} className="weight-rim">
                <div className="weight-rim-head">
                  <strong>
                    {rim.variables.length > 1 ? 'Interlocked rim' : 'Rim'}
                  </strong>
                  <span className="spacer" />
                  <label className="muted">
                    Missing:{' '}
                    <select
                      value={rim.missing}
                      onChange={(e) =>
                        setMissing(rim, e.target.value as 'exclude' | 'category')
                      }
                    >
                      <option value="exclude">Exclude</option>
                      <option value="category">Separate category</option>
                    </select>
                  </label>
                  {rim.variables.length === 2 && (
                    <label className="muted">
                      Targets:{' '}
                      <select
                        value={rim.basis}
                        onChange={(e) =>
                          setBasis(rim, e.target.value as 'overall' | 'column')
                        }
                      >
                        <option value="overall">Overall %</option>
                        <option value="column">
                          % within {labelFor(rim.variables[1])}
                        </option>
                      </select>
                    </label>
                  )}
                  <button className="danger" onClick={() => removeRim(rim.id)}>
                    Remove
                  </button>
                </div>

                <div className="weight-rim-vars">
                  {rim.variables.map((v) => (
                    <button
                      key={v}
                      className="ct-chip"
                      onClick={() => removeRimVariable(rim, v)}
                      title="Remove (cross fewer variables)"
                    >
                      {labelFor(v)} ✕
                    </button>
                  ))}
                  <select
                    value=""
                    onChange={(e) => addRimVariable(rim, e.target.value)}
                  >
                    <option value="">
                      {rim.variables.length ? '+ cross with…' : 'Weight on…'}
                    </option>
                    {weightable
                      .filter((v) => !rim.variables.includes(v.name))
                      .map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.label}
                        </option>
                      ))}
                  </select>
                </div>

                {busy === rim.id && <p className="muted">Loading categories…</p>}
                {rim.cells.length > 0 &&
                  (rim.variables.length === 2 ? (
                    <WeightCellsMatrix
                      rim={rim}
                      rowLabel={labelFor(rim.variables[0])}
                      colLabel={labelFor(rim.variables[1])}
                      perColumn={perColumn}
                      offTarget={offTarget}
                      onPercent={(index, percent) =>
                        setPercent(rim.id, index, percent)
                      }
                    />
                  ) : (
                    <table className="grid values weight-cells">
                      <thead>
                        <tr>
                          <th>Category</th>
                          <th style={{ width: '7rem' }}>Target %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rim.cells.map((c, i) => (
                          <tr key={c.values.join(KEY_SEP)}>
                            <td>{c.values.join(' · ')}</td>
                            <td>
                              <input
                                className="cell-input"
                                type="number"
                                value={c.percent}
                                onChange={(e) =>
                                  setPercent(rim.id, i, Number(e.target.value))
                                }
                              />
                            </td>
                          </tr>
                        ))}
                        <tr>
                          <td className="muted">Total</td>
                          <td className={offTarget ? 'error' : 'muted'}>
                            {sum.toFixed(1)}%
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  ))}
                {offTarget && (
                  <p className="error">
                    {perColumn
                      ? `Each ${labelFor(rim.variables[1])} column must total 100%.`
                      : `Targets add to ${sum.toFixed(1)}% — adjust them to total 100%.`}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <button onClick={addRim} style={{ marginTop: '0.5rem' }}>
          + Add rim
        </button>

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save weight'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Two-variable interlocked targets shown as a crosstab: rows = first variable,
// columns = the "cross with" variable, with row/column subtotals.
function WeightCellsMatrix({
  rim,
  rowLabel,
  colLabel,
  perColumn,
  offTarget,
  onPercent,
}: {
  rim: WeightRim
  rowLabel: string
  colLabel: string
  perColumn: boolean
  offTarget: boolean
  onPercent: (index: number, percent: number) => void
}) {
  const rowVals: string[] = []
  const colVals: string[] = []
  const byKey = new Map<string, { percent: number; index: number }>()
  rim.cells.forEach((c, i) => {
    if (!rowVals.includes(c.values[0])) rowVals.push(c.values[0])
    if (!colVals.includes(c.values[1])) colVals.push(c.values[1])
    byKey.set(c.values[0] + KEY_SEP + c.values[1], { percent: c.percent, index: i })
  })
  const colTotal = (cv: string) =>
    rowVals.reduce((a, rv) => a + (byKey.get(rv + KEY_SEP + cv)?.percent || 0), 0)
  const grand = rim.cells.reduce((a, c) => a + (c.percent || 0), 0)

  return (
    <table className="grid values weight-cells">
      <thead>
        <tr>
          <th>
            {rowLabel} <span className="muted">\</span> {colLabel}
          </th>
          {colVals.map((cv) => (
            <th key={cv}>{cv}</th>
          ))}
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        {rowVals.map((rv) => {
          const rowTotal = colVals.reduce(
            (a, cv) => a + (byKey.get(rv + KEY_SEP + cv)?.percent || 0),
            0,
          )
          return (
            <tr key={rv}>
              <td>{rv}</td>
              {colVals.map((cv) => {
                const hit = byKey.get(rv + KEY_SEP + cv)
                return (
                  <td key={cv}>
                    {hit ? (
                      <input
                        className="cell-input"
                        type="number"
                        value={hit.percent}
                        onChange={(e) =>
                          onPercent(hit.index, Number(e.target.value))
                        }
                      />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                )
              })}
              <td className="muted">{rowTotal.toFixed(1)}%</td>
            </tr>
          )
        })}
        <tr>
          <td className="muted">Total</td>
          {colVals.map((cv) => (
            <td
              key={cv}
              className={
                perColumn && Math.abs(colTotal(cv) - 100) > 0.5 ? 'error' : 'muted'
              }
            >
              {colTotal(cv).toFixed(1)}%
            </td>
          ))}
          <td className={!perColumn && offTarget ? 'error' : 'muted'}>
            {grand.toFixed(1)}%
          </td>
        </tr>
      </tbody>
    </table>
  )
}
