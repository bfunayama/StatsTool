import { useEffect, useMemo, useState } from 'react'
import {
  bandVariable,
  binaryVariable,
  copyVariable,
  deleteVariable,
  getDistinct,
  updateVariables,
  type Band,
  type DatasetMeta,
  type DistinctValue,
  type Recode,
  type ValueAttribute,
  type Variable,
  type VariableType,
} from '../api'

interface Props {
  meta: DatasetMeta
  onChanged: (meta: DatasetMeta) => void
}

const TYPES: VariableType[] = [
  'categorical',
  'numeric',
  'datetime',
  'text',
  'binary',
]

// Keep a recoded variable's value attributes in step with its recode rule.
function valuesForRecode(recode: Recode): ValueAttribute[] {
  if (recode.kind === 'band') {
    return recode.bands.map((b, i) => ({
      source_value: b.label,
      value: i + 1,
      label: b.label,
      missing: false,
    }))
  }
  return [
    { source_value: recode.false_label, value: 0, label: recode.false_label, missing: false },
    { source_value: recode.true_label, value: 1, label: recode.true_label, missing: false },
  ]
}

export function VariableEditor({ meta, onChanged }: Props) {
  const [variables, setVariables] = useState<Variable[]>(meta.variables)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bandFor, setBandFor] = useState<Variable | null>(null)
  const [binaryFor, setBinaryFor] = useState<Variable | null>(null)

  // Re-sync whenever the dataset metadata changes (save, create, delete).
  useEffect(() => {
    setVariables(meta.variables)
    setDirty(false)
  }, [meta])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return variables
    return variables.filter(
      (v) =>
        v.name.toLowerCase().includes(q) || v.label.toLowerCase().includes(q),
    )
  }, [variables, search])

  function patchVariable(name: string, patch: Partial<Variable>) {
    setVariables((prev) =>
      prev.map((v) => (v.name === name ? { ...v, ...patch } : v)),
    )
    setDirty(true)
  }

  function patchValue(
    varName: string,
    index: number,
    patch: Partial<Variable['values'][number]>,
  ) {
    setVariables((prev) =>
      prev.map((v) =>
        v.name === varName
          ? {
              ...v,
              values: v.values.map((val, i) =>
                i === index ? { ...val, ...patch } : val,
              ),
            }
          : v,
      ),
    )
    setDirty(true)
  }

  function patchRecode(name: string, recode: Recode) {
    setVariables((prev) =>
      prev.map((v) =>
        v.name === name
          ? { ...v, recode, values: valuesForRecode(recode) }
          : v,
      ),
    )
    setDirty(true)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      onChanged(await updateVariables(meta.id, variables))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function run(action: () => Promise<DatasetMeta>) {
    setError(null)
    try {
      onChanged(await action())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    }
  }

  return (
    <div>
      <div className="toolbar">
        <input
          className="search"
          placeholder="Filter variables…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="muted">
          {filtered.length} of {variables.length} variables
        </span>
        <span className="spacer" />
        {dirty && <span className="muted">Unsaved changes</span>}
        <button className="primary" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
      {dirty && (
        <p className="muted" style={{ marginTop: 0 }}>
          Save your edits before copying or recoding a variable.
        </p>
      )}
      {error && <p className="error">{error}</p>}

      <div className="table-scroll">
        <table className="grid vars">
          <thead>
            <tr>
              <th style={{ width: '2rem' }} />
              <th>Variable</th>
              <th>Label</th>
              <th style={{ width: '9rem' }}>Type</th>
              <th style={{ width: '16rem' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((v) => {
              const canExpand = v.values.length > 0 || v.recode !== null
              const isOpen = expanded === v.name
              return (
                <VariableRow
                  key={v.name}
                  variable={v}
                  datasetId={meta.id}
                  isOpen={isOpen}
                  canExpand={canExpand}
                  dirty={dirty}
                  onToggle={() =>
                    setExpanded(isOpen ? null : canExpand ? v.name : null)
                  }
                  onLabel={(label) => patchVariable(v.name, { label })}
                  onType={(type) => patchVariable(v.name, { type })}
                  onValuePatch={(i, patch) => patchValue(v.name, i, patch)}
                  onRecode={(recode) => patchRecode(v.name, recode)}
                  onCopy={() => run(() => copyVariable(meta.id, v.name))}
                  onBand={() => setBandFor(v)}
                  onBinary={() => setBinaryFor(v)}
                  onDelete={() => {
                    if (confirm(`Delete variable "${v.label}"?`))
                      run(() => deleteVariable(meta.id, v.name))
                  }}
                />
              )
            })}
          </tbody>
        </table>
      </div>

      {bandFor && (
        <BandDialog
          datasetId={meta.id}
          variable={bandFor}
          onClose={() => setBandFor(null)}
          onCreated={(m) => {
            setBandFor(null)
            onChanged(m)
          }}
        />
      )}
      {binaryFor && (
        <BinaryDialog
          datasetId={meta.id}
          variable={binaryFor}
          onClose={() => setBinaryFor(null)}
          onCreated={(m) => {
            setBinaryFor(null)
            onChanged(m)
          }}
        />
      )}
    </div>
  )
}

interface RowProps {
  variable: Variable
  datasetId: string
  isOpen: boolean
  canExpand: boolean
  dirty: boolean
  onToggle: () => void
  onLabel: (label: string) => void
  onType: (type: VariableType) => void
  onValuePatch: (index: number, patch: Partial<Variable['values'][number]>) => void
  onRecode: (recode: Recode) => void
  onCopy: () => void
  onBand: () => void
  onBinary: () => void
  onDelete: () => void
}

function VariableRow({
  variable,
  datasetId,
  isOpen,
  canExpand,
  dirty,
  onToggle,
  onLabel,
  onType,
  onValuePatch,
  onRecode,
  onCopy,
  onBand,
  onBinary,
  onDelete,
}: RowProps) {
  const derived = variable.source_name !== null
  const isNumeric = variable.type === 'numeric'
  const isCategorical = variable.type === 'categorical'
  const disabledTitle = dirty ? 'Save changes first' : undefined

  return (
    <>
      <tr>
        <td>
          {canExpand && (
            <button className="expand" onClick={onToggle} aria-label="Toggle values">
              {isOpen ? '▾' : '▸'}
            </button>
          )}
        </td>
        <td className="var-name">
          {variable.name}
          {derived && <span className="badge">derived</span>}
        </td>
        <td>
          <input
            className="cell-input"
            value={variable.label}
            onChange={(e) => onLabel(e.target.value)}
          />
        </td>
        <td>
          <select
            value={variable.type}
            onChange={(e) => onType(e.target.value as VariableType)}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </td>
        <td>
          <div className="row-actions">
            <button onClick={onCopy} disabled={dirty} title={disabledTitle}>
              Copy
            </button>
            {isNumeric && (
              <button onClick={onBand} disabled={dirty} title={disabledTitle}>
                Band…
              </button>
            )}
            {isCategorical && (
              <button onClick={onBinary} disabled={dirty} title={disabledTitle}>
                Binary…
              </button>
            )}
            {derived && (
              <button
                onClick={onDelete}
                disabled={dirty}
                title={disabledTitle}
                className="danger"
              >
                Delete
              </button>
            )}
          </div>
        </td>
      </tr>
      {isOpen && (
        <tr className="values-row">
          <td />
          <td colSpan={4}>
            {variable.recode === null ? (
              <ValueAttributesEditor variable={variable} onValuePatch={onValuePatch} />
            ) : variable.recode.kind === 'band' ? (
              <BandInlineEditor recode={variable.recode} onRecode={onRecode} />
            ) : (
              <BinaryInlineEditor
                datasetId={datasetId}
                sourceName={variable.source_name}
                recode={variable.recode}
                onRecode={onRecode}
              />
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function ValueAttributesEditor({
  variable,
  onValuePatch,
}: {
  variable: Variable
  onValuePatch: (index: number, patch: Partial<Variable['values'][number]>) => void
}) {
  return (
    <div className="values-editor">
      <p className="muted">
        Value attributes — the value is used in averages; ticking Missing excludes
        that value from analysis.
      </p>
      <table className="grid values">
        <thead>
          <tr>
            <th style={{ width: '6rem' }}>Value</th>
            <th style={{ width: '35%' }}>Source</th>
            <th>Label</th>
            <th style={{ width: '5rem' }}>Missing</th>
          </tr>
        </thead>
        <tbody>
          {variable.values.map((val, i) => (
            <tr key={val.source_value + i}>
              <td>
                <input
                  className="cell-input"
                  type="number"
                  value={val.value ?? ''}
                  onChange={(e) =>
                    onValuePatch(i, {
                      value: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
              </td>
              <td className="var-name">{val.source_value}</td>
              <td>
                <input
                  className="cell-input"
                  value={val.label}
                  onChange={(e) => onValuePatch(i, { label: e.target.value })}
                />
              </td>
              <td style={{ textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={val.missing}
                  onChange={(e) => onValuePatch(i, { missing: e.target.checked })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BandInlineEditor({
  recode,
  onRecode,
}: {
  recode: Extract<Recode, { kind: 'band' }>
  onRecode: (recode: Recode) => void
}) {
  function setBands(bands: Band[]) {
    onRecode({ kind: 'band', bands })
  }
  function update(i: number, patch: Partial<Band>) {
    setBands(recode.bands.map((b, idx) => (idx === i ? { ...b, ...patch } : b)))
  }

  return (
    <div className="values-editor">
      <p className="muted">
        Edit the ranges, then Save. Leave a bound blank for open-ended.
      </p>
      <table className="grid" style={{ maxWidth: '40rem' }}>
        <thead>
          <tr>
            <th style={{ width: '7rem' }}>Min</th>
            <th style={{ width: '7rem' }}>Max</th>
            <th>Label</th>
            <th style={{ width: '3rem' }} />
          </tr>
        </thead>
        <tbody>
          {recode.bands.map((b, i) => (
            <tr key={i}>
              <td>
                <input
                  className="cell-input"
                  type="number"
                  value={b.min ?? ''}
                  onChange={(e) =>
                    update(i, {
                      min: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
              </td>
              <td>
                <input
                  className="cell-input"
                  type="number"
                  value={b.max ?? ''}
                  onChange={(e) =>
                    update(i, {
                      max: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
              </td>
              <td>
                <input
                  className="cell-input"
                  value={b.label}
                  onChange={(e) => update(i, { label: e.target.value })}
                />
              </td>
              <td>
                <button
                  onClick={() =>
                    setBands(recode.bands.filter((_, idx) => idx !== i))
                  }
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        onClick={() =>
          setBands([...recode.bands, { min: null, max: null, label: '' }])
        }
      >
        + Add band
      </button>
    </div>
  )
}

function BinaryInlineEditor({
  datasetId,
  sourceName,
  recode,
  onRecode,
}: {
  datasetId: string
  sourceName: string | null
  recode: Extract<Recode, { kind: 'binary' }>
  onRecode: (recode: Recode) => void
}) {
  const [values, setValues] = useState<DistinctValue[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sourceName) return
    getDistinct(datasetId, sourceName)
      .then((d) => setValues(d.values))
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load values'),
      )
  }, [datasetId, sourceName])

  const selected = new Set(recode.true_values)
  function toggle(value: string) {
    const next = new Set(selected)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onRecode({ ...recode, true_values: Array.from(next) })
  }

  return (
    <div className="values-editor">
      <p className="muted">
        Tick the source values that count as <strong>{recode.true_label}</strong>,
        then Save.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="checkbox-list" style={{ maxWidth: '30rem' }}>
        {values === null ? (
          <p className="muted">Loading values…</p>
        ) : (
          values.map((v) => (
            <label key={v.value} className="checkbox-item">
              <input
                type="checkbox"
                checked={selected.has(v.value)}
                onChange={() => toggle(v.value)}
              />
              {v.value} <span className="muted">({v.count})</span>
            </label>
          ))
        )}
      </div>
      <div className="label-inputs">
        <label>
          True label
          <input
            value={recode.true_label}
            onChange={(e) => onRecode({ ...recode, true_label: e.target.value })}
          />
        </label>
        <label>
          False label
          <input
            value={recode.false_label}
            onChange={(e) => onRecode({ ...recode, false_label: e.target.value })}
          />
        </label>
      </div>
    </div>
  )
}

interface BandRow {
  min: string
  max: string
  label: string
}

function BandDialog({
  datasetId,
  variable,
  onClose,
  onCreated,
}: {
  datasetId: string
  variable: Variable
  onClose: () => void
  onCreated: (meta: DatasetMeta) => void
}) {
  const [rows, setRows] = useState<BandRow[]>([{ min: '', max: '', label: '' }])
  const [range, setRange] = useState<{ min: number | null; max: number | null } | null>(
    null,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getDistinct(datasetId, variable.name)
      .then((d) => setRange({ min: d.min, max: d.max }))
      .catch(() => setRange(null))
  }, [datasetId, variable.name])

  function update(i: number, patch: Partial<BandRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  async function create() {
    const bands: Band[] = rows
      .filter((r) => r.label.trim() !== '')
      .map((r) => ({
        min: r.min === '' ? null : Number(r.min),
        max: r.max === '' ? null : Number(r.max),
        label: r.label.trim(),
      }))
    if (bands.length === 0) {
      setError('Add at least one band with a label.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      onCreated(await bandVariable(datasetId, variable.name, bands))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create bands')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Band "${variable.label}"`} onClose={onClose}>
      {range && (
        <p className="muted">
          Data range: {range.min ?? '?'} to {range.max ?? '?'}. Leave a bound blank
          for open-ended (e.g. blank Min = everything up to Max).
        </p>
      )}
      <table className="grid">
        <thead>
          <tr>
            <th>Min</th>
            <th>Max</th>
            <th>Label</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <input
                  className="cell-input"
                  type="number"
                  value={r.min}
                  onChange={(e) => update(i, { min: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="cell-input"
                  type="number"
                  value={r.max}
                  onChange={(e) => update(i, { max: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="cell-input"
                  value={r.label}
                  onChange={(e) => update(i, { label: e.target.value })}
                />
              </td>
              <td>
                <button
                  onClick={() =>
                    setRows((prev) => prev.filter((_, idx) => idx !== i))
                  }
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        onClick={() =>
          setRows((prev) => [...prev, { min: '', max: '', label: '' }])
        }
      >
        + Add band
      </button>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={create} disabled={busy}>
          {busy ? 'Creating…' : 'Create banded variable'}
        </button>
      </div>
    </Modal>
  )
}

function BinaryDialog({
  datasetId,
  variable,
  onClose,
  onCreated,
}: {
  datasetId: string
  variable: Variable
  onClose: () => void
  onCreated: (meta: DatasetMeta) => void
}) {
  const [values, setValues] = useState<DistinctValue[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [trueLabel, setTrueLabel] = useState('Selected')
  const [falseLabel, setFalseLabel] = useState('Not selected')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getDistinct(datasetId, variable.name)
      .then((d) => setValues(d.values))
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load values'),
      )
  }, [datasetId, variable.name])

  function toggle(value: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  async function create() {
    if (selected.size === 0) {
      setError('Select at least one value to count as True.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      onCreated(
        await binaryVariable(datasetId, variable.name, Array.from(selected), {
          true_label: trueLabel,
          false_label: falseLabel,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create binary')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Make "${variable.label}" binary`} onClose={onClose}>
      <p className="muted">Tick the values that should count as True.</p>
      <div className="checkbox-list">
        {values === null ? (
          <p className="muted">Loading values…</p>
        ) : (
          values.map((v) => (
            <label key={v.value} className="checkbox-item">
              <input
                type="checkbox"
                checked={selected.has(v.value)}
                onChange={() => toggle(v.value)}
              />
              {v.value} <span className="muted">({v.count})</span>
            </label>
          ))
        )}
      </div>
      <div className="label-inputs">
        <label>
          True label
          <input value={trueLabel} onChange={(e) => setTrueLabel(e.target.value)} />
        </label>
        <label>
          False label
          <input value={falseLabel} onChange={(e) => setFalseLabel(e.target.value)} />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={create} disabled={busy}>
          {busy ? 'Creating…' : 'Create binary variable'}
        </button>
      </div>
    </Modal>
  )
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="expand" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
