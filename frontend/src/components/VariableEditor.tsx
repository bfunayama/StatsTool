import { useEffect, useMemo, useState } from 'react'
import { WeightDialog } from './WeightDialog'
import {
  bandVariable,
  binaryVariable,
  coalesceVariable,
  copyVariable,
  deleteVariable,
  getDistinct,
  pickAnyCompact,
  previewCoalesce,
  previewPickAnyCompact,
  saveQuestions,
  updateVariables,
  type Band,
  type CoalescePreview,
  type DatasetMeta,
  type DistinctValue,
  type PickAnyCompactPreview,
  type Question,
  type QuestionKind,
  type Recode,
  type ValueAttribute,
  type Variable,
  type VariableType,
} from '../api'
import { useBackdropDismiss } from '../useBackdropDismiss'

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
  const [questions, setQuestions] = useState<Question[]>(meta.questions ?? [])
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bandFor, setBandFor] = useState<Variable | null>(null)
  const [binaryFor, setBinaryFor] = useState<Variable | null>(null)
  const [pickAnyFor, setPickAnyFor] = useState<Variable | null>(null)
  const [combineOpen, setCombineOpen] = useState(false)
  const [confirmAction, setConfirmAction] = useState<{
    title: string
    message: string
    confirmLabel?: string
    onConfirm: () => void
  } | null>(null)
  const [weightDialog, setWeightDialog] = useState<{ initial: Variable | null } | null>(
    null,
  )

  // Re-sync whenever the dataset metadata changes (save, create, delete).
  useEffect(() => {
    setVariables(meta.variables)
    setQuestions(meta.questions ?? [])
    setDirty(false)
  }, [meta])

  // One combined list: each question appears in place of its first column,
  // the rest of its columns are hidden (merged into the question entry).
  const rows = useMemo(() => {
    const byColumn = new Map<string, Question>()
    for (const q of questions)
      for (const it of q.items) byColumn.set(it.column, q)

    const built: Array<
      { kind: 'variable'; variable: Variable } | { kind: 'question'; question: Question }
    > = []
    const emitted = new Set<string>()
    for (const v of variables) {
      const q = byColumn.get(v.name)
      if (q) {
        if (!emitted.has(q.id)) {
          emitted.add(q.id)
          built.push({ kind: 'question', question: q })
        }
        continue
      }
      built.push({ kind: 'variable', variable: v })
    }

    const term = search.trim().toLowerCase()
    if (!term) return built
    return built.filter((row) => {
      if (row.kind === 'variable') {
        const v = row.variable
        return (
          v.name.toLowerCase().includes(term) ||
          v.label.toLowerCase().includes(term)
        )
      }
      const q = row.question
      return (
        q.name.toLowerCase().includes(term) ||
        q.label.toLowerCase().includes(term) ||
        q.items.some(
          (i) =>
            i.column.toLowerCase().includes(term) ||
            i.label.toLowerCase().includes(term),
        )
      )
    })
  }, [variables, questions, search])

  const variableCount = rows.filter((r) => r.kind === 'variable').length
  const questionCount = rows.filter((r) => r.kind === 'question').length

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

  function patchQuestion(id: string, patch: Partial<Question>) {
    setQuestions((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } : q)))
    setDirty(true)
  }

  function patchQuestionItem(id: string, column: string, label: string) {
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === id
          ? {
              ...q,
              items: q.items.map((i) =>
                i.column === column ? { ...i, label } : i,
              ),
            }
          : q,
      ),
    )
    setDirty(true)
  }

  function patchQuestionAxis(
    id: string,
    axis: 'rows' | 'columns',
    key: string,
    label: string,
  ) {
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === id
          ? {
              ...q,
              [axis]: q[axis].map((a) => (a.key === key ? { ...a, label } : a)),
            }
          : q,
      ),
    )
    setDirty(true)
  }

  function removeQuestionItem(id: string, column: string) {
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === id
          ? { ...q, items: q.items.filter((i) => i.column !== column) }
          : q,
      ),
    )
    setDirty(true)
  }

  function ungroupQuestion(id: string) {
    setConfirmAction({
      title: 'Ungroup question',
      message:
        'Ungroup this question? Its columns return to the variable list.',
      confirmLabel: 'Ungroup',
      onConfirm: () => {
        setQuestions((prev) => prev.filter((q) => q.id !== id))
        setDirty(true)
      },
    })
  }

  // A question whose every column is a derived variable (e.g. a compact
  // pick-any) can be deleted outright; raw-column groups can only be ungrouped.
  function questionIsDerived(q: Question) {
    return (
      q.items.length > 0 &&
      q.items.every((it) => {
        const mv = variables.find((v) => v.name === it.column)
        return mv != null && mv.source_name != null
      })
    )
  }

  function deleteQuestion(q: Question) {
    setConfirmAction({
      title: 'Delete pick-any question',
      message: `Delete "${q.label}" and its ${q.items.length} derived columns? The original column is kept (unhidden).`,
      onConfirm: () => {
        const memberCols = new Set(q.items.map((i) => i.column))
        const sources = new Set<string>()
        for (const it of q.items) {
          const mv = variables.find((v) => v.name === it.column)
          if (mv?.source_name) sources.add(mv.source_name)
        }
        setVariables((prev) =>
          prev
            .filter((v) => !memberCols.has(v.name))
            .map((v) => (sources.has(v.name) ? { ...v, hidden: false } : v)),
        )
        setQuestions((prev) => prev.filter((x) => x.id !== q.id))
        setDirty(true)
      },
    })
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await updateVariables(meta.id, variables)
      onChanged(await saveQuestions(meta.id, questions.filter((q) => q.items.length > 0)))
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
          {variableCount} variables
          {questionCount > 0 && `, ${questionCount} grouped variables`}
        </span>
        <span className="spacer" />
        {dirty && <span className="muted">Unsaved changes</span>}
        <button
          onClick={() => setCombineOpen(true)}
          disabled={dirty}
          title={dirty ? 'Save changes first' : undefined}
        >
          Combine variables…
        </button>
        <button onClick={() => setWeightDialog({ initial: null })}>
          New weight
        </button>
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
            {rows.map((row) => {
              if (row.kind === 'question') {
                const q = row.question
                const key = `q:${q.id}`
                const isOpen = expanded === key
                return (
                  <QuestionRow
                    key={key}
                    question={q}
                    isOpen={isOpen}
                    onToggle={() => setExpanded(isOpen ? null : key)}
                    onLabel={(label) => patchQuestion(q.id, { label })}
                    onKind={(kind) => patchQuestion(q.id, { kind })}
                    onItemLabel={(column, label) =>
                      patchQuestionItem(q.id, column, label)
                    }
                    onAxisLabel={(axis, key, label) =>
                      patchQuestionAxis(q.id, axis, key, label)
                    }
                    onRemoveItem={(column) => removeQuestionItem(q.id, column)}
                    onUngroup={() => ungroupQuestion(q.id)}
                    onDelete={
                      questionIsDerived(q) ? () => deleteQuestion(q) : undefined
                    }
                  />
                )
              }
              const v = row.variable
              const isOpen = expanded === v.name
              return (
                <VariableRow
                  key={v.name}
                  variable={v}
                  datasetId={meta.id}
                  isOpen={isOpen}
                  dirty={dirty}
                  onToggle={() => setExpanded(isOpen ? null : v.name)}
                  onLabel={(label) => patchVariable(v.name, { label })}
                  onType={(type) => patchVariable(v.name, { type })}
                  onValuePatch={(i, patch) => patchValue(v.name, i, patch)}
                  onRecode={(recode) => patchRecode(v.name, recode)}
                  onCopy={() => run(() => copyVariable(meta.id, v.name))}
                  onBand={() => setBandFor(v)}
                  onBinary={() => setBinaryFor(v)}
                  onPickAny={() => setPickAnyFor(v)}
                  onEditWeight={() => setWeightDialog({ initial: v })}
                  onDelete={() =>
                    setConfirmAction({
                      title: 'Delete variable',
                      message: `Delete variable "${v.label}"?`,
                      onConfirm: () =>
                        run(() => deleteVariable(meta.id, v.name)),
                    })
                  }
                  onToggleHidden={() =>
                    patchVariable(v.name, { hidden: !v.hidden })
                  }
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
      {pickAnyFor && (
        <PickAnyCompactDialog
          datasetId={meta.id}
          variable={pickAnyFor}
          onClose={() => setPickAnyFor(null)}
          onCreated={(m) => {
            setPickAnyFor(null)
            onChanged(m)
          }}
        />
      )}
      {combineOpen && (
        <CombineDialog
          datasetId={meta.id}
          candidates={variables.filter((v) => v.type !== 'weight' && !v.hidden)}
          onClose={() => setCombineOpen(false)}
          onCreated={(m) => {
            setCombineOpen(false)
            onChanged(m)
          }}
        />
      )}
      {confirmAction && (
        <Modal title={confirmAction.title} onClose={() => setConfirmAction(null)}>
          <p className="muted">{confirmAction.message}</p>
          <div className="modal-actions">
            <button onClick={() => setConfirmAction(null)}>Cancel</button>
            <button
              className="danger"
              onClick={() => {
                confirmAction.onConfirm()
                setConfirmAction(null)
              }}
            >
              {confirmAction.confirmLabel ?? 'Delete'}
            </button>
          </div>
        </Modal>
      )}
      {weightDialog && (
        <WeightDialog
          datasetId={meta.id}
          variables={variables}
          initial={weightDialog.initial}
          onClose={() => setWeightDialog(null)}
          onSaved={(m) => {
            setWeightDialog(null)
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
  dirty: boolean
  onToggle: () => void
  onLabel: (label: string) => void
  onType: (type: VariableType) => void
  onValuePatch: (index: number, patch: Partial<Variable['values'][number]>) => void
  onRecode: (recode: Recode) => void
  onCopy: () => void
  onBand: () => void
  onBinary: () => void
  onPickAny: () => void
  onEditWeight: () => void
  onDelete: () => void
  onToggleHidden: () => void
}

function QuestionRow({
  question,
  isOpen,
  onToggle,
  onLabel,
  onKind,
  onItemLabel,
  onAxisLabel,
  onRemoveItem,
  onUngroup,
  onDelete,
}: {
  question: Question
  isOpen: boolean
  onToggle: () => void
  onLabel: (label: string) => void
  onKind: (kind: QuestionKind) => void
  onItemLabel: (column: string, label: string) => void
  onAxisLabel: (axis: 'rows' | 'columns', key: string, label: string) => void
  onRemoveItem: (column: string) => void
  onUngroup: () => void
  onDelete?: () => void
}) {
  return (
    <>
      <tr>
        <td>
          <button className="expand" onClick={onToggle} aria-label="Toggle columns">
            {isOpen ? '▾' : '▸'}
          </button>
        </td>
        <td className="var-name">
          {question.name}
          <span className="badge">grouped variable</span>
        </td>
        <td>
          <input
            className="cell-input"
            value={question.label}
            onChange={(e) => onLabel(e.target.value)}
          />
        </td>
        <td>
          <select
            value={question.kind}
            onChange={(e) => onKind(e.target.value as QuestionKind)}
          >
            <option value="multi">Pick any</option>
            <option value="grid">Grid</option>
            <option value="grid2d">Grid (2-D)</option>
          </select>
        </td>
        <td>
          <div className="row-actions">
            <span className="muted">{question.items.length} cols</span>
            <button onClick={onUngroup}>Ungroup</button>
            {onDelete && (
              <button className="danger" onClick={onDelete}>
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
            <div className="values-editor">
              {question.kind === 'grid2d' ? (
                <>
                  <p className="muted">
                    A two-dimensional grid: {question.rows.length} rows ×{' '}
                    {question.columns.length} columns ({question.items.length} cells).
                  </p>
                  <div className="axis-tables">
                    <AxisEditor
                      title="Rows"
                      axis="rows"
                      labels={question.rows}
                      onAxisLabel={onAxisLabel}
                    />
                    <AxisEditor
                      title="Columns"
                      axis="columns"
                      labels={question.columns}
                      onAxisLabel={onAxisLabel}
                    />
                  </div>
                </>
              ) : (
                <>
                  <p className="muted">
                    {question.kind === 'multi'
                      ? 'Each column is one selectable option.'
                      : 'Each column is a row/item; all share the scale below.'}
                  </p>
                  <table className="grid values" style={{ maxWidth: '44rem' }}>
                    <thead>
                      <tr>
                        <th>Column</th>
                        <th>
                          {question.kind === 'multi' ? 'Option label' : 'Row label'}
                        </th>
                        <th style={{ width: '3rem' }} />
                      </tr>
                    </thead>
                    <tbody>
                      {question.items.map((it) => (
                        <tr key={it.column}>
                          <td className="var-name">{it.column}</td>
                          <td>
                            <input
                              className="cell-input"
                              value={it.label}
                              onChange={(e) => onItemLabel(it.column, e.target.value)}
                            />
                          </td>
                          <td>
                            <button
                              onClick={() => onRemoveItem(it.column)}
                              title="Remove from question"
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              {question.categories.length > 0 && (
                <p className="muted" style={{ marginTop: '0.5rem' }}>
                  Scale: {question.categories.join(' · ')}
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function AxisEditor({
  title,
  axis,
  labels,
  onAxisLabel,
}: {
  title: string
  axis: 'rows' | 'columns'
  labels: { key: string; label: string }[]
  onAxisLabel: (axis: 'rows' | 'columns', key: string, label: string) => void
}) {
  return (
    <table className="grid values" style={{ maxWidth: '22rem' }}>
      <thead>
        <tr>
          <th style={{ width: '3rem' }}>#</th>
          <th>{title}</th>
        </tr>
      </thead>
      <tbody>
        {labels.map((a) => (
          <tr key={a.key}>
            <td className="var-name">{a.key}</td>
            <td>
              <input
                className="cell-input"
                value={a.label}
                onChange={(e) => onAxisLabel(axis, a.key, e.target.value)}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function VariableRow({
  variable,
  datasetId,
  isOpen,
  dirty,
  onToggle,
  onLabel,
  onType,
  onValuePatch,
  onRecode,
  onCopy,
  onBand,
  onBinary,
  onPickAny,
  onEditWeight,
  onDelete,
  onToggleHidden,
}: RowProps) {
  // Combined (coalesce) variables have no source_name but are still derived.
  const derived =
    variable.source_name !== null || variable.recode?.kind === 'coalesce'
  const isNumeric = variable.type === 'numeric'
  const isCategorical = variable.type === 'categorical'
  const isText = variable.type === 'text'
  const isWeight = variable.type === 'weight'
  const disabledTitle = dirty ? 'Save changes first' : undefined

  return (
    <>
      <tr className={variable.hidden ? 'hidden-var' : undefined}>
        <td>
          <button className="expand" onClick={onToggle} aria-label="Toggle values">
            {isOpen ? '▾' : '▸'}
          </button>
        </td>
        <td className="var-name">
          {variable.name}
          {isWeight && <span className="badge">weight</span>}
          {derived && <span className="badge">derived</span>}
          {variable.hidden && <span className="badge">hidden</span>}
        </td>
        <td>
          <input
            className="cell-input"
            value={variable.label}
            onChange={(e) => onLabel(e.target.value)}
          />
        </td>
        <td>
          {isWeight ? (
            <span className="muted">weight</span>
          ) : (
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
          )}
        </td>
        <td>
          <div className="row-actions">
            <button
              onClick={onToggleHidden}
              title="Hide from filter, crosstab and driver lists (data is kept)"
            >
              {variable.hidden ? 'Show in lists' : 'Hide from lists'}
            </button>
            {isWeight ? (
              <>
                <button onClick={onEditWeight}>Edit weight</button>
                <button onClick={onDelete} className="danger">
                  Delete
                </button>
              </>
            ) : (
              <>
                <button onClick={onToggle}>{isOpen ? 'Hide' : 'View'}</button>
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
                {(!derived || variable.recode?.kind === 'coalesce') &&
                  (isCategorical || isText) && (
                    <button onClick={onPickAny} disabled={dirty} title={disabledTitle}>
                      Pick Any…
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
              </>
            )}
          </div>
        </td>
      </tr>
      {isOpen && !isWeight && (
        <tr className="values-row">
          <td />
          <td colSpan={4}>
            {variable.recode === null ? (
              variable.values.length > 0 ? (
                <ValueAttributesEditor variable={variable} onValuePatch={onValuePatch} />
              ) : (
                <RawValuesView datasetId={datasetId} variableName={variable.name} />
              )
            ) : variable.recode.kind === 'band' ? (
              <BandInlineEditor recode={variable.recode} onRecode={onRecode} />
            ) : variable.recode.kind === 'binary' ? (
              <BinaryInlineEditor
                datasetId={datasetId}
                sourceName={variable.source_name}
                recode={variable.recode}
                onRecode={onRecode}
              />
            ) : variable.values.length > 0 ? (
              <ValueAttributesEditor variable={variable} onValuePatch={onValuePatch} />
            ) : (
              <RawValuesView datasetId={datasetId} variableName={variable.name} />
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

function RawValuesView({
  datasetId,
  variableName,
}: {
  datasetId: string
  variableName: string
}) {
  const [values, setValues] = useState<DistinctValue[] | null>(null)
  const [state, setState] = useState<'loading' | 'error' | 'idle'>('loading')

  useEffect(() => {
    let ignore = false
    setState('loading')
    setValues(null)
    getDistinct(datasetId, variableName)
      .then((d) => {
        if (ignore) return
        setValues(d.values)
        setState('idle')
      })
      .catch(() => {
        if (ignore) return
        setState('error')
      })
    return () => {
      ignore = true
    }
  }, [datasetId, variableName])

  return (
    <div className="values-editor">
      <p className="muted">
        Distinct values found in this variable (read-only). This variable has no
        value labels — copy it and add labels, or band it, to relabel.
      </p>
      {state === 'loading' ? (
        <p className="muted">Loading values…</p>
      ) : state === 'error' ? (
        <p className="error">Couldn't load values.</p>
      ) : values && values.length === 0 ? (
        <p className="muted">No values to show.</p>
      ) : (
        <table className="grid values" style={{ maxWidth: '30rem' }}>
          <thead>
            <tr>
              <th>Value</th>
              <th style={{ width: '8rem' }}>Count</th>
            </tr>
          </thead>
          <tbody>
            {(values ?? []).map((d) => (
              <tr key={d.value}>
                <td>{d.value}</td>
                <td className="muted">{d.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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

function PickAnyCompactDialog({
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
  const DELIMITERS: { value: string; label: string }[] = [
    { value: '|', label: 'Pipe  |' },
    { value: ';', label: 'Semicolon  ;' },
    { value: ',', label: 'Comma  ,' },
  ]
  const [delimiter, setDelimiter] = useState<string | null>(null)
  const [preview, setPreview] = useState<PickAnyCompactPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    previewPickAnyCompact(datasetId, variable.name, delimiter)
      .then((p) => {
        if (!active) return
        setPreview(p)
        if (delimiter === null && p.delimiter) setDelimiter(p.delimiter)
      })
      .catch((err) =>
        active && setError(err instanceof Error ? err.message : 'Preview failed'),
      )
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [datasetId, variable.name, delimiter])

  async function create() {
    setBusy(true)
    setError(null)
    try {
      onCreated(await pickAnyCompact(datasetId, variable.name, delimiter))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create pick-any')
    } finally {
      setBusy(false)
    }
  }

  const options = preview?.options ?? []
  const noneFound = !loading && preview?.delimiter == null && delimiter == null

  return (
    <Modal title={`Split "${variable.label}" into Pick Any`} onClose={onClose}>
      <p className="muted">
        Each respondent&apos;s selected answers are packed into one cell. This
        keeps the original column and creates a multi-response question you can
        crosstab, NET and export.
      </p>
      <label className="pickany-delim">
        Separator
        <select
          value={delimiter ?? ''}
          onChange={(e) => setDelimiter(e.target.value || null)}
        >
          <option value="">Auto-detect</option>
          {DELIMITERS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      {loading ? (
        <p className="muted">Scanning answers…</p>
      ) : noneFound ? (
        <p className="muted">
          No multi-answer separator found. Pick a separator above to split on.
        </p>
      ) : (
        <>
          <p className="muted">
            {options.length} options · {preview?.respondents ?? 0} answered ·{' '}
            {preview?.multi_selected ?? 0} chose more than one
          </p>
          <div className="checkbox-list">
            {options.map((o) => (
              <div key={o.label} className="pickany-opt">
                {o.label} <span className="muted">({o.count})</span>
              </div>
            ))}
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          onClick={create}
          disabled={busy || loading || options.length === 0}
        >
          {busy ? 'Creating…' : 'Create pick-any question'}
        </button>
      </div>
    </Modal>
  )
}

function CombineDialog({
  datasetId,
  candidates,
  onClose,
  onCreated,
}: {
  datasetId: string
  candidates: Variable[]
  onClose: () => void
  onCreated: (meta: DatasetMeta) => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [mode, setMode] = useState<'merge' | 'grid'>('merge')
  const [label, setLabel] = useState('')
  const [labelEdited, setLabelEdited] = useState(false)
  const [preview, setPreview] = useState<CoalescePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (selected.length < 2) {
      setPreview(null)
      return
    }
    let active = true
    setLoading(true)
    previewCoalesce(datasetId, selected)
      .then((p) => {
        if (!active) return
        setPreview(p)
        if (!labelEdited) setLabel(p.suggested_label)
      })
      .catch((err) =>
        active && setError(err instanceof Error ? err.message : 'Preview failed'),
      )
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [datasetId, selected, labelEdited])

  function toggle(name: string) {
    setError(null)
    setSelected((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    )
  }

  async function create() {
    setBusy(true)
    setError(null)
    try {
      onCreated(
        await coalesceVariable(datasetId, selected, label || undefined, mode),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to combine')
    } finally {
      setBusy(false)
    }
  }

  const term = search.trim().toLowerCase()
  const filtered = term
    ? candidates.filter(
        (v) =>
          v.label.toLowerCase().includes(term) ||
          v.name.toLowerCase().includes(term),
      )
    : candidates
  const nSources = preview?.sources.length ?? selected.length
  // Merging pick-any (multi-select) option columns is a trap: coalesce keeps only
  // the first ticked option per respondent and drops the rest.
  const pickAnySelected = selected.filter(
    (n) => candidates.find((v) => v.name === n)?.recode?.kind === 'compact_select',
  ).length
  const mergeWarning =
    mode === 'merge' && selected.length >= 2
      ? pickAnySelected >= 2
        ? 'These look like pick-any (multi-select) option columns. Merge keeps only each respondent’s first ticked option and drops the rest — so most people collapse onto the first option. To compare a multi-select question across variants, build a combined pick-any instead, or use “Compare side by side”.'
        : preview && preview.conflict_n >= Math.max(3, Math.ceil(preview.base_n * 0.2))
          ? `${preview.conflict_n} respondents answered more than one source. Merge keeps only the first and drops the rest — if these aren’t mutually-exclusive variants, use “Compare side by side” instead.`
          : null
      : null

  return (
    <Modal title="Combine variables" onClose={onClose}>
      <p className="muted">
        Combine parallel columns — e.g. the same question asked under different
        variants that came out in separate columns.
      </p>
      <div className="combine-modes">
        <label className="combine-mode">
          <input
            type="radio"
            checked={mode === 'merge'}
            onChange={() => setMode('merge')}
          />
          <span>
            <strong>Merge into one variable</strong>
            <span className="muted">
              {' '}— each respondent keeps the first answer they gave (in tick
              order). Best for between-subjects variants (one answer per person).
            </span>
          </span>
        </label>
        <label className="combine-mode">
          <input
            type="radio"
            checked={mode === 'grid'}
            onChange={() => setMode('grid')}
          />
          <span>
            <strong>Compare side by side</strong>
            <span className="muted">
              {' '}— keeps each column as its own row in a comparison grid, each
              counted on its own base. For within-subjects variants, where a
              respondent may have answered more than one, every answer is counted.
            </span>
          </span>
        </label>
      </div>
      <input
        className="search"
        placeholder="Filter variables…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="checkbox-list">
        {filtered.map((v) => {
          const pos = selected.indexOf(v.name)
          return (
            <label key={v.name} className="checkbox-item">
              <input
                type="checkbox"
                checked={pos >= 0}
                onChange={() => toggle(v.name)}
              />
              {pos >= 0 && <span className="combine-order">{pos + 1}</span>}
              {v.label} <span className="muted">({v.type})</span>
            </label>
          )
        })}
      </div>
      {selected.length < 2 ? (
        <p className="muted">Tick at least two variables to combine.</p>
      ) : loading ? (
        <p className="muted">Checking…</p>
      ) : preview ? (
        <>
          <p className="muted">
            {preview.base_n} answered ·{' '}
            {preview.conflict_n > 0
              ? mode === 'grid'
                ? `${preview.conflict_n} answered more than one (counted under each)`
                : `${preview.conflict_n} answered more than one (first ticked wins)`
              : 'no overlap between sources'}
          </p>
          {mergeWarning && <p className="combine-warning">⚠ {mergeWarning}</p>}
          <label className="pickany-delim">
            {mode === 'grid' ? 'Question name' : 'Name'}
            <input
              value={label}
              onChange={(e) => {
                setLabel(e.target.value)
                setLabelEdited(true)
              }}
            />
          </label>
          {preview.numeric ? (
            <p className="muted">Combined as a numeric variable.</p>
          ) : (
            <div className="checkbox-list">
              {preview.labels.map((l) => (
                <div
                  key={l.label}
                  className={
                    l.in_sources < nSources
                      ? 'combine-opt partial'
                      : 'combine-opt'
                  }
                >
                  {l.label}
                  {l.in_sources < nSources && (
                    <span className="muted">
                      {' '}
                      (only in {l.in_sources} of {nSources})
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          onClick={create}
          disabled={busy || selected.length < 2}
        >
          {busy
            ? 'Creating…'
            : mode === 'grid'
              ? 'Create comparison grid'
              : 'Create combined variable'}
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
  const backdrop = useBackdropDismiss()
  return (
    <div className="modal-backdrop" {...backdrop(onClose)}>
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
