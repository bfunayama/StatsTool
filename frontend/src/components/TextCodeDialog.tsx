import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createTextCode,
  getVerbatims,
  type DatasetMeta,
  type Variable,
  type VerbatimItem,
} from '../api'
import { useBackdropDismiss } from '../useBackdropDismiss'

// A coding job reconstructed from an existing coded variable, for re-editing.
export interface TextCodeInitial {
  sourceVariable: string
  mode: 'one' | 'any'
  label: string
  categories: { label: string; values: string[] }[]
  replace: string // variable name (Pick One) or question id (Pick Any)
}

interface Category {
  id: string
  label: string
  values: string[]
}

const NO_ANSWER = '(No answer)'
// Virtual bucket for verbatims not yet coded into any user category.
const UNCODED = '__uncoded__'

// Chooser: pick what kind of new variable to create.
export function NewVariableDialog({
  onClose,
  onChooseText,
}: {
  onClose: () => void
  onChooseText: () => void
}) {
  const backdrop = useBackdropDismiss()
  return (
    <div className="modal-backdrop" {...backdrop(onClose)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>New variable</h3>
          <button className="expand" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="newvar-options">
          <button className="newvar-card" disabled>
            <strong>From logic (IF / AND / OR)</strong>
            <span className="muted">
              Build a variable from conditions over existing variables.
            </span>
            <span className="badge">Coming soon</span>
          </button>
          <button className="newvar-card" onClick={onChooseText}>
            <strong>Code open-ended text</strong>
            <span className="muted">
              Categorise verbatim responses into a Pick One or Pick Any variable.
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}

export function TextCodeDialog({
  datasetId,
  textVariables,
  initial,
  onClose,
  onCreated,
}: {
  datasetId: string
  textVariables: Variable[]
  initial?: TextCodeInitial | null
  onClose: () => void
  onCreated: (meta: DatasetMeta) => void
}) {
  const backdrop = useBackdropDismiss()
  const editing = !!initial
  const [sourceVariable, setSourceVariable] = useState(
    initial?.sourceVariable ?? textVariables[0]?.name ?? '',
  )
  const [mode, setMode] = useState<'one' | 'any'>(initial?.mode ?? 'any')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [categories, setCategories] = useState<Category[]>(
    (initial?.categories ?? []).map((c) => ({
      id: crypto.randomUUID(),
      label: c.label,
      values: c.values,
    })),
  )
  const [verbatims, setVerbatims] = useState<VerbatimItem[]>([])
  const [total, setTotal] = useState(0)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  // Which category's verbatims the left pane shows (Uncoded by default).
  const [focused, setFocused] = useState<string>(UNCODED)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingCat, setEditingCat] = useState<string | null>(null)
  const lastIndex = useRef<number | null>(null)
  const clickTimer = useRef<number | null>(null)

  const sourceLabel =
    textVariables.find((v) => v.name === sourceVariable)?.label ?? sourceVariable

  // Load the verbatims for the chosen text column.
  useEffect(() => {
    if (!sourceVariable) {
      setVerbatims([])
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    setError(null)
    getVerbatims(datasetId, sourceVariable)
      .then((r) => {
        if (!active) return
        setVerbatims(r.verbatims)
        setTotal(r.total)
      })
      .catch(
        (err) =>
          active && setError(err instanceof Error ? err.message : 'Load failed'),
      )
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [datasetId, sourceVariable])

  const countByValue = useMemo(() => {
    const m = new Map<string, number>()
    for (const v of verbatims) m.set(v.value, v.count)
    return m
  }, [verbatims])

  // Every verbatim already coded into at least one user category.
  const codedValues = useMemo(() => {
    const s = new Set<string>()
    for (const c of categories) for (const v of c.values) s.add(v)
    return s
  }, [categories])

  // The verbatims shown in the left pane = those in the focused category, plus any
  // currently selected ones (so a verbatim stays put while you code it into several
  // categories, and only leaves the view once you move to another response).
  const focusedVerbatims = useMemo(() => {
    const inFocus = (value: string) => {
      if (focused === UNCODED) return !codedValues.has(value)
      const cat = categories.find((c) => c.id === focused)
      return !!cat && cat.values.includes(value)
    }
    return verbatims.filter((v) => inFocus(v.value) || selection.has(v.value))
  }, [verbatims, focused, categories, codedValues, selection])

  const codedCount = useMemo(() => {
    let n = 0
    for (const v of codedValues) n += countByValue.get(v) ?? 0
    return n
  }, [codedValues, countByValue])

  // A right-pane category is highlighted when every selected verbatim is in it.
  function isHighlighted(id: string): boolean {
    if (selection.size === 0) return false
    const sel = [...selection]
    if (id === UNCODED) return sel.every((v) => !codedValues.has(v))
    const cat = categories.find((c) => c.id === id)
    if (!cat) return false
    const set = new Set(cat.values)
    return sel.every((v) => set.has(v))
  }

  function selectVerbatim(e: React.MouseEvent, idx: number) {
    const value = focusedVerbatims[idx].value
    if (e.shiftKey && lastIndex.current !== null) {
      const a = Math.min(lastIndex.current, idx)
      const b = Math.max(lastIndex.current, idx)
      const range = focusedVerbatims.slice(a, b + 1).map((v) => v.value)
      setSelection((prev) => new Set([...prev, ...range]))
    } else if (e.metaKey || e.ctrlKey) {
      setSelection((prev) => {
        const next = new Set(prev)
        if (next.has(value)) next.delete(value)
        else next.add(value)
        return next
      })
      lastIndex.current = idx
    } else {
      // Plain click selects only this one; clicking it again clears the selection.
      setSelection((prev) =>
        prev.size === 1 && prev.has(value) ? new Set() : new Set([value]),
      )
      lastIndex.current = idx
    }
  }

  // Single click a category = (re)code the selection into/out of it; "Uncoded"
  // sends them back to uncoded by removing them from every user category.
  function clickCategory(id: string) {
    if (selection.size === 0) return
    const sel = [...selection]
    if (id === UNCODED) {
      setCategories((prev) =>
        prev.map((c) => ({
          ...c,
          values: c.values.filter((v) => !selection.has(v)),
        })),
      )
      return
    }
    const target = categories.find((c) => c.id === id)
    if (!target) return
    const allIn = sel.every((v) => target.values.includes(v))
    setCategories((prev) =>
      prev.map((c) => {
        if (c.id === id) {
          if (allIn)
            return { ...c, values: c.values.filter((v) => !selection.has(v)) }
          return { ...c, values: Array.from(new Set([...c.values, ...sel])) }
        }
        // Pick One is mutually exclusive: assigning removes from other categories.
        if (mode === 'one' && !allIn)
          return { ...c, values: c.values.filter((v) => !selection.has(v)) }
        return c
      }),
    )
  }

  // Double click a category = drill in: show its verbatims in the left pane.
  function focusCategory(id: string) {
    setFocused(id)
    setSelection(new Set())
    lastIndex.current = null
  }

  // Distinguish single (code) from double (focus) click on a category row.
  function onCategoryClick(id: string) {
    if (clickTimer.current !== null) {
      window.clearTimeout(clickTimer.current)
      clickTimer.current = null
      focusCategory(id)
      return
    }
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null
      clickCategory(id)
    }, 220)
  }

  function addCategory() {
    const cat = { id: crypto.randomUUID(), label: '', values: [] }
    setCategories((prev) => [...prev, cat])
    setEditingCat(cat.id)
    // Clear selection so naming the new category can't accidentally code it.
    setSelection(new Set())
    lastIndex.current = null
  }

  function renameCategory(id: string, label: string) {
    setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, label } : c)))
  }

  function deleteCategory(id: string) {
    setCategories((prev) => prev.filter((c) => c.id !== id))
  }

  // Switching to Pick One enforces one category per verbatim (keep the first).
  function changeMode(next: 'one' | 'any') {
    setMode(next)
    if (next === 'one') {
      const seen = new Set<string>()
      setCategories((prev) =>
        prev.map((c) => ({
          ...c,
          values: c.values.filter((v) => (seen.has(v) ? false : seen.add(v))),
        })),
      )
    }
  }

  const named = categories.filter((c) => c.label.trim())
  const canSave =
    !!sourceVariable &&
    named.length > 0 &&
    named.some((c) => c.values.length > 0) &&
    !busy

  async function save() {
    const labels = named.map((c) => c.label.trim())
    if (new Set(labels).size !== labels.length) {
      setError('Category names must be unique.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const meta = await createTextCode(datasetId, {
        source_variable: sourceVariable,
        mode,
        new_label: label.trim() || sourceLabel,
        categories: named.map((c) => ({ label: c.label.trim(), values: c.values })),
        replace: initial?.replace ?? null,
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
      <div
        className="modal textcode-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{editing ? 'Edit coded variable' : 'Code open-ended text'}</h3>
          <button className="expand" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="textcode-setup">
          <label className="field">
            Text variable
            <select
              value={sourceVariable}
              disabled={editing}
              onChange={(e) => {
                setSourceVariable(e.target.value)
                setSelection(new Set())
              }}
            >
              {textVariables.length === 0 && <option value="">No text variables</option>}
              {textVariables.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            New variable name
            <input
              className="cell-input"
              placeholder={sourceLabel}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className="field">
            Type
            <select
              value={mode}
              onChange={(e) => changeMode(e.target.value as 'one' | 'any')}
            >
              <option value="one">Pick One (mutually exclusive)</option>
              <option value="any">Pick Any (multiple allowed)</option>
            </select>
          </label>
          <span className="spacer" />
          <span className="muted">
            {codedCount} / {total} coded
          </span>
        </div>

        {error && <p className="error">{error}</p>}

        <div className="textcode-panes">
          <div className="textcode-pane">
            <div className="textcode-pane-head">
              <strong>
                {focused === UNCODED
                  ? 'Uncoded'
                  : categories.find((c) => c.id === focused)?.label || 'Untitled'}
              </strong>
              <span className="muted">
                {focusedVerbatims.length} distinct · click / Shift / ⌘-Ctrl to
                select
              </span>
            </div>
            <div className="textcode-list">
              {loading ? (
                <p className="muted">Loading responses…</p>
              ) : focusedVerbatims.length === 0 ? (
                <p className="muted">
                  {focused === UNCODED
                    ? 'All responses are coded.'
                    : 'No responses in this category yet.'}
                </p>
              ) : (
                focusedVerbatims.map((v, idx) => (
                  <div
                    key={v.value || '__blank__'}
                    className={
                      'verbatim-row' + (selection.has(v.value) ? ' selected' : '')
                    }
                    onClick={(e) => selectVerbatim(e, idx)}
                  >
                    <span className="verbatim-text">
                      {v.value === '' ? (
                        <em className="muted">{NO_ANSWER}</em>
                      ) : (
                        v.value
                      )}{' '}
                      <span className="muted">({v.count})</span>
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="textcode-pane">
            <div className="textcode-pane-head">
              <strong>Categories</strong>
              <button onClick={addCategory}>+ Add category</button>
            </div>
            <div className="textcode-list">
              <div className={'cat-row' + (focused === UNCODED ? ' focused' : '')}>
                <button
                  className={
                    'cat-assign' + (isHighlighted(UNCODED) ? ' highlight' : '')
                  }
                  title="Click to send selected responses back to Uncoded; double-click to view them"
                  onClick={() => onCategoryClick(UNCODED)}
                >
                  <span className="cat-name">
                    Uncoded
                    <span className="muted">
                      {' '}
                      ({total > 0 ? (((total - codedCount) / total) * 100).toFixed(0) : 0}%, n=
                      {total - codedCount})
                    </span>
                  </span>
                </button>
              </div>
              {categories.length === 0 && (
                <p className="muted">
                  Add categories, select responses on the left, then click a
                  category to code them. Double-click a category to view it.
                </p>
              )}
              {categories.map((c) => {
                const n = c.values.reduce(
                  (a, v) => a + (countByValue.get(v) ?? 0),
                  0,
                )
                const pct = total > 0 ? (n / total) * 100 : 0
                return (
                  <div
                    key={c.id}
                    className={'cat-row' + (focused === c.id ? ' focused' : '')}
                  >
                    <button
                      className={
                        'cat-assign' + (isHighlighted(c.id) ? ' highlight' : '')
                      }
                      title="Click to code selected responses here; double-click to view this category"
                      onClick={() => onCategoryClick(c.id)}
                    >
                      {editingCat === c.id ? (
                        <input
                          className="cell-input"
                          autoFocus
                          value={c.label}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => renameCategory(c.id, e.target.value)}
                          onBlur={() => setEditingCat(null)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === 'Escape')
                              setEditingCat(null)
                          }}
                        />
                      ) : (
                        <span className="cat-name">
                          {c.label || <em className="muted">Untitled</em>}
                          <span className="muted">
                            {' '}
                            ({pct.toFixed(0)}%, n={n})
                          </span>
                        </span>
                      )}
                    </button>
                    <button
                      className="cat-edit"
                      title="Rename"
                      onClick={() => setEditingCat(c.id)}
                    >
                      ✎
                    </button>
                    <button
                      className="cat-del danger"
                      title="Delete category"
                      onClick={() => deleteCategory(c.id)}
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!canSave} onClick={save}>
            {busy
              ? 'Saving…'
              : editing
                ? 'Save changes'
                : 'Create variable'}
          </button>
        </div>
      </div>
    </div>
  )
}
