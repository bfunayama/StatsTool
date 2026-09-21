import { useEffect, useMemo, useRef, useState } from 'react'
import {
  filterCount,
  getDistinct,
  saveFilters,
  type Condition,
  type DatasetMeta,
  type DistinctValue,
  type Filter,
  type Operator,
  type Variable,
} from '../api'

interface Props {
  meta: DatasetMeta
  onChanged: (meta: DatasetMeta) => void
}

const NUMERIC_OPS: Operator[] = [
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'between',
  'is_missing',
  'not_missing',
]
const CATEGORY_OPS: Operator[] = ['in', 'not_in', 'is_missing', 'not_missing']

const OP_LABEL: Record<Operator, string> = {
  in: 'is any of',
  not_in: 'is not any of',
  eq: '=',
  ne: '≠',
  lt: '<',
  le: '≤',
  gt: '>',
  ge: '≥',
  between: 'between',
  is_missing: 'is missing',
  not_missing: 'is not missing',
}

function newId(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `f${Date.now()}${Math.random().toString(16).slice(2)}`
}

function operatorsFor(type: string): Operator[] {
  return type === 'numeric' ? NUMERIC_OPS : CATEGORY_OPS
}

export function FiltersManager({ meta, onChanged }: Props) {
  const [editing, setEditing] = useState<Filter | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function persist(filters: Filter[]) {
    setError(null)
    try {
      onChanged(await saveFilters(meta.id, filters))
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    }
  }

  function saveOne(filter: Filter) {
    const others = meta.filters.filter((f) => f.id !== filter.id)
    persist([...others, filter])
  }

  function remove(id: string) {
    if (confirm('Delete this filter?'))
      persist(meta.filters.filter((f) => f.id !== id))
  }

  if (editing) {
    return (
      <FilterEditor
        meta={meta}
        filter={editing}
        onSave={saveOne}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <div>
      <div className="toolbar">
        <h3 style={{ margin: 0 }}>Filters</h3>
        <span className="spacer" />
        <button
          className="primary"
          onClick={() =>
            setEditing({
              id: newId(),
              name: 'New filter',
              match: 'all',
              conditions: [],
            })
          }
        >
          New filter
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <p className="muted">
        A filter is a reusable subset of respondents (e.g. a customer segment) you
        can apply to the data and, later, to crosstabs.
      </p>
      {meta.filters.length === 0 ? (
        <p className="muted">No filters yet.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              <th>Conditions</th>
              <th>Match</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {meta.filters.map((f) => (
              <tr key={f.id}>
                <td>{f.name}</td>
                <td>{f.conditions.length}</td>
                <td>{f.match === 'all' ? 'All (AND)' : 'Any (OR)'}</td>
                <td>
                  <div className="row-actions">
                    <button onClick={() => setEditing(f)}>Edit</button>
                    <button className="danger" onClick={() => remove(f.id)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function FilterEditor({
  meta,
  filter,
  onSave,
  onCancel,
}: {
  meta: DatasetMeta
  filter: Filter
  onSave: (filter: Filter) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<Filter>(filter)
  const [count, setCount] = useState<{ count: number; total: number } | null>(
    null,
  )
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      filterCount(meta.id, draft)
        .then(setCount)
        .catch(() => setCount(null))
    }, 350)
    return () => window.clearTimeout(timer.current)
  }, [draft, meta.id])

  function setConditions(conditions: Condition[]) {
    setDraft((d) => ({ ...d, conditions }))
  }

  function addCondition() {
    const first = meta.variables[0]
    const type = first?.type ?? 'categorical'
    setConditions([
      ...draft.conditions,
      {
        variable: first?.name ?? '',
        operator: type === 'numeric' ? 'ge' : 'in',
        values: [],
        number: null,
        number2: null,
      },
    ])
  }

  return (
    <div>
      <div className="toolbar">
        <input
          className="search"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <span className="spacer" />
        {count && (
          <span className="muted">
            Selects <strong>{count.count}</strong> of {count.total}
          </span>
        )}
        <button onClick={onCancel}>Cancel</button>
        <button
          className="primary"
          onClick={() => onSave(draft)}
          disabled={draft.name.trim() === ''}
        >
          Save filter
        </button>
      </div>

      <div className="match-row">
        <span>Respondents must match</span>
        <label>
          <input
            type="radio"
            checked={draft.match === 'all'}
            onChange={() => setDraft({ ...draft, match: 'all' })}
          />
          all conditions (AND)
        </label>
        <label>
          <input
            type="radio"
            checked={draft.match === 'any'}
            onChange={() => setDraft({ ...draft, match: 'any' })}
          />
          any condition (OR)
        </label>
      </div>

      {draft.conditions.map((c, i) => (
        <ConditionRow
          key={i}
          meta={meta}
          condition={c}
          onChange={(patch) =>
            setConditions(
              draft.conditions.map((x, idx) =>
                idx === i ? { ...x, ...patch } : x,
              ),
            )
          }
          onRemove={() =>
            setConditions(draft.conditions.filter((_, idx) => idx !== i))
          }
        />
      ))}
      <button onClick={addCondition}>+ Add condition</button>
    </div>
  )
}

function ConditionRow({
  meta,
  condition,
  onChange,
  onRemove,
}: {
  meta: DatasetMeta
  condition: Condition
  onChange: (patch: Partial<Condition>) => void
  onRemove: () => void
}) {
  const variable: Variable | undefined = useMemo(
    () => meta.variables.find((v) => v.name === condition.variable),
    [meta.variables, condition.variable],
  )
  const ops = operatorsFor(variable?.type ?? 'categorical')
  const needsValues =
    condition.operator === 'in' || condition.operator === 'not_in'

  const [distinct, setDistinct] = useState<DistinctValue[] | null>(null)
  const [valuesState, setValuesState] = useState<'idle' | 'loading' | 'error'>(
    'idle',
  )
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    if (!needsValues || !condition.variable) {
      setDistinct(null)
      setValuesState('idle')
      return
    }
    let ignore = false
    setValuesState('loading')
    setDistinct(null)
    getDistinct(meta.id, condition.variable)
      .then((d) => {
        if (ignore) return
        setDistinct(d.values)
        setValuesState('idle')
      })
      .catch(() => {
        if (ignore) return
        setDistinct(null)
        setValuesState('error')
      })
    return () => {
      ignore = true
    }
  }, [meta.id, condition.variable, needsValues, reloadKey])

  function pickVariable(name: string) {
    const v = meta.variables.find((x) => x.name === name)
    const type = v?.type ?? 'categorical'
    onChange({
      variable: name,
      operator: type === 'numeric' ? 'ge' : 'in',
      values: [],
      number: null,
      number2: null,
    })
  }

  function toggleValue(value: string) {
    const set = new Set(condition.values)
    if (set.has(value)) set.delete(value)
    else set.add(value)
    onChange({ values: Array.from(set) })
  }

  return (
    <div className="condition">
      <div className="condition-head">
        <select
          value={condition.variable}
          onChange={(e) => pickVariable(e.target.value)}
        >
          {meta.variables.map((v) => (
            <option key={v.name} value={v.name}>
              {v.label}
            </option>
          ))}
        </select>
        <select
          value={condition.operator}
          onChange={(e) => onChange({ operator: e.target.value as Operator })}
        >
          {ops.map((op) => (
            <option key={op} value={op}>
              {OP_LABEL[op]}
            </option>
          ))}
        </select>
        {condition.operator === 'between' ? (
          <>
            <input
              type="number"
              placeholder="min"
              value={condition.number ?? ''}
              onChange={(e) =>
                onChange({
                  number: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
            <input
              type="number"
              placeholder="max"
              value={condition.number2 ?? ''}
              onChange={(e) =>
                onChange({
                  number2: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
          </>
        ) : condition.operator === 'is_missing' ||
          condition.operator === 'not_missing' ? null : needsValues ? null : (
          <input
            type="number"
            value={condition.number ?? ''}
            onChange={(e) =>
              onChange({
                number: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        )}
        <span className="spacer" />
        <button onClick={onRemove}>✕</button>
      </div>
      {needsValues && (
        <div className="checkbox-list" style={{ maxWidth: '30rem' }}>
          {valuesState === 'loading' ? (
            <p className="muted">Loading values…</p>
          ) : valuesState === 'error' ? (
            <p className="error">
              Couldn't load values for this variable.{' '}
              <button onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
            </p>
          ) : distinct && distinct.length === 0 ? (
            <p className="muted">No values to choose from.</p>
          ) : (
            (distinct ?? []).map((d) => (
              <label key={d.value} className="checkbox-item">
                <input
                  type="checkbox"
                  checked={condition.values.includes(d.value)}
                  onChange={() => toggleValue(d.value)}
                />
                {d.value} <span className="muted">({d.count})</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  )
}
