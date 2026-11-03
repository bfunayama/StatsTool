import { useEffect, useMemo, useState } from 'react'
import {
  createCountVariable,
  getDistinct,
  type DatasetMeta,
  type Question,
  type Variable,
} from '../api'
import { useBackdropDismiss } from '../useBackdropDismiss'

type Mode = 'selected' | 'equals' | 'mode_freq'

interface Unit {
  id: string
  label: string
  columns: string[]
  tag: string
}

export function CountDialog({
  datasetId,
  variables,
  questions,
  onClose,
  onCreated,
}: {
  datasetId: string
  variables: Variable[]
  questions: Question[]
  onClose: () => void
  onCreated: (meta: DatasetMeta) => void
}) {
  const backdrop = useBackdropDismiss()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<Mode>('selected')
  const [value, setValue] = useState('')
  const [label, setLabel] = useState('')
  const [search, setSearch] = useState('')
  const [distinct, setDistinct] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Selectable units: Pick-Any/grid questions (expand to member columns) and
  // standalone variables.
  const units = useMemo<Unit[]>(() => {
    const memberOf = new Map<string, Question>()
    for (const q of questions) for (const it of q.items) memberOf.set(it.column, q)
    const out: Unit[] = []
    const emitted = new Set<string>()
    for (const v of variables) {
      if (v.type === 'weight') continue
      const q = memberOf.get(v.name)
      if (q) {
        if ((q.kind === 'multi' || q.kind === 'grid') && !emitted.has(q.id)) {
          emitted.add(q.id)
          out.push({
            id: `q:${q.id}`,
            label: q.label,
            columns: q.items.map((it) => it.column),
            tag: `${q.items.length} cols`,
          })
        }
        continue
      }
      if (v.hidden) continue
      out.push({ id: `v:${v.name}`, label: v.label, columns: [v.name], tag: v.type })
    }
    return out
  }, [variables, questions])

  const sources = useMemo(() => {
    const s: string[] = []
    for (const u of units) if (selected.has(u.id)) s.push(...u.columns)
    return s
  }, [units, selected])

  // Candidate values for "equals" come from the first chosen column's scale.
  const firstSource = sources[0]
  useEffect(() => {
    if (mode !== 'equals' || !firstSource) {
      setDistinct([])
      return
    }
    let active = true
    getDistinct(datasetId, firstSource)
      .then((r) => active && setDistinct(r.values.map((d) => d.value)))
      .catch(() => active && setDistinct([]))
    return () => {
      active = false
    }
  }, [datasetId, mode, firstSource])

  const term = search.trim().toLowerCase()
  const filtered = term
    ? units.filter((u) => u.label.toLowerCase().includes(term))
    : units

  const canCreate =
    sources.length > 0 && (mode !== 'equals' || !!value) && !busy

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const meta = await createCountVariable(datasetId, {
        sources,
        mode,
        values: mode === 'equals' && value ? [value] : [],
        new_label: label.trim() || 'Count',
      })
      onCreated(meta)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create variable')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" {...backdrop(onClose)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Count across columns</h3>
          <button className="expand" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="muted">
          Counts, per respondent, how many of the chosen columns meet the
          condition. A respondent with no answers gets 0. Creates a numeric
          variable.
        </p>

        <input
          className="search"
          placeholder="Filter variables…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="checkbox-list">
          {filtered.map((u) => {
            const on = selected.has(u.id)
            return (
              <label key={u.id} className="checkbox-item">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (next.has(u.id)) next.delete(u.id)
                      else next.add(u.id)
                      return next
                    })
                  }
                />
                {u.label} <span className="muted">({u.tag})</span>
              </label>
            )
          })}
        </div>
        <p className="muted">
          {sources.length} column{sources.length === 1 ? '' : 's'} selected
        </p>

        <label className="field">
          Count when a column…
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="selected">Has any answer (selected)</option>
            <option value="equals">Equals a value…</option>
            <option value="mode_freq">Most-common-answer frequency</option>
          </select>
        </label>

        {mode === 'equals' && (
          <label className="field">
            Value to count
            <select value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">Choose a value…</option>
              {distinct.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}

        {mode === 'mode_freq' && (
          <p className="muted">
            A <strong>straightlining data-quality check</strong>: the count is how
            many of the chosen columns share each respondent&apos;s most-common
            answer. A high value means they gave the same answer to most/all
            columns (e.g. flat-lining a grid).
          </p>
        )}

        <label className="field">
          New variable name
          <input
            className="cell-input"
            placeholder="Count"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>

        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!canCreate} onClick={create}>
            {busy ? 'Creating…' : 'Create variable'}
          </button>
        </div>
      </div>
    </div>
  )
}
