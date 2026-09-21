import { useMemo, useState } from 'react'
import {
  updateVariables,
  type DatasetMeta,
  type Variable,
  type VariableType,
} from '../api'

interface Props {
  meta: DatasetMeta
  onSaved: (meta: DatasetMeta) => void
}

const TYPES: VariableType[] = ['categorical', 'numeric', 'datetime', 'text']

export function VariableEditor({ meta, onSaved }: Props) {
  const [variables, setVariables] = useState<Variable[]>(meta.variables)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  function patchValueLabel(varName: string, value: string, label: string) {
    setVariables((prev) =>
      prev.map((v) =>
        v.name === varName
          ? {
              ...v,
              value_labels: v.value_labels.map((vl) =>
                vl.value === value ? { ...vl, label } : vl,
              ),
            }
          : v,
      ),
    )
    setDirty(true)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateVariables(meta.id, variables)
      setVariables(updated.variables)
      setDirty(false)
      onSaved(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
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
      {error && <p className="error">{error}</p>}

      <div className="table-scroll">
        <table className="grid vars">
          <thead>
            <tr>
              <th style={{ width: '2rem' }} />
              <th>Variable</th>
              <th>Label</th>
              <th style={{ width: '10rem' }}>Type</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((v) => {
              const isOpen = expanded === v.name
              const canExpand = v.type === 'categorical'
              return (
                <FragmentRow
                  key={v.name}
                  variable={v}
                  isOpen={isOpen}
                  canExpand={canExpand}
                  onToggle={() =>
                    setExpanded(isOpen ? null : canExpand ? v.name : null)
                  }
                  onLabel={(label) => patchVariable(v.name, { label })}
                  onType={(type) =>
                    patchVariable(v.name, { type: type as VariableType })
                  }
                  onValueLabel={(value, label) =>
                    patchValueLabel(v.name, value, label)
                  }
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

interface RowProps {
  variable: Variable
  isOpen: boolean
  canExpand: boolean
  onToggle: () => void
  onLabel: (label: string) => void
  onType: (type: string) => void
  onValueLabel: (value: string, label: string) => void
}

function FragmentRow({
  variable,
  isOpen,
  canExpand,
  onToggle,
  onLabel,
  onType,
  onValueLabel,
}: RowProps) {
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
        <td className="var-name">{variable.name}</td>
        <td>
          <input
            className="cell-input"
            value={variable.label}
            onChange={(e) => onLabel(e.target.value)}
          />
        </td>
        <td>
          <select value={variable.type} onChange={(e) => onType(e.target.value)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </td>
      </tr>
      {isOpen && (
        <tr className="values-row">
          <td />
          <td colSpan={3}>
            <div className="values-editor">
              <p className="muted">
                {variable.value_labels.length} values — edit the labels shown in
                analysis.
              </p>
              <table className="grid values">
                <thead>
                  <tr>
                    <th style={{ width: '40%' }}>Value</th>
                    <th>Label</th>
                  </tr>
                </thead>
                <tbody>
                  {variable.value_labels.map((vl) => (
                    <tr key={vl.value}>
                      <td className="var-name">{vl.value}</td>
                      <td>
                        <input
                          className="cell-input"
                          value={vl.label}
                          onChange={(e) => onValueLabel(vl.value, e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
