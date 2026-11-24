import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  computeSegmentation,
  saveSegmentationVariable,
  type DatasetMeta,
  type SegmentationResponse,
  type SegmentationSpec,
  type Variable,
} from '../api'

interface Props {
  datasetId: string
  meta: DatasetMeta
  name: string
  spec: SegmentationSpec
  onSave: (name: string, spec: SegmentationSpec) => void
  onChanged: (meta: DatasetMeta) => void
}

const MIN_CLASSES = 2
const MAX_CLASSES = 10
// Index at or above this is shown in bold: a clear over-representation.
const HIGH_INDEX = 120

export function defaultSegmentationSpec(): SegmentationSpec {
  return {
    indicators: [],
    classes_mode: 'auto',
    n_classes: 3,
    max_classes: 6,
    weight: null,
    filter_id: null,
    variable_name: '',
  }
}

// Indicators are categorical answers: categorical/binary variables, or any
// variable with at least two value labels. Text, dates and weights are excluded.
function isIndicator(v: Variable): boolean {
  if (v.hidden || v.type === 'weight' || v.type === 'text' || v.type === 'datetime')
    return false
  if (v.type === 'categorical' || v.type === 'binary') return true
  return (v.values ?? []).filter((a) => !a.missing).length >= 2
}

function inRange(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_CLASSES && value <= MAX_CLASSES
}

export function SegmentationPanel({
  datasetId,
  meta,
  name,
  spec,
  onSave,
  onChanged,
}: Props) {
  const [title, setTitle] = useState(name)
  const [draft, setDraft] = useState<SegmentationSpec>(() => ({
    ...defaultSegmentationSpec(),
    ...spec,
  }))
  const [varLabel, setVarLabel] = useState('Segment')
  const [result, setResult] = useState<SegmentationResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)

  const dirty =
    title.trim() !== name || JSON.stringify(draft) !== JSON.stringify(spec)

  const byName = useMemo(() => {
    const m = new Map<string, Variable>()
    meta.variables.forEach((v) => m.set(v.name, v))
    return m
  }, [meta.variables])

  const indicatorVars = useMemo(
    () => meta.variables.filter(isIndicator),
    [meta.variables],
  )
  const standalone = useMemo(
    () => indicatorVars.filter((v) => !v.question_id),
    [indicatorVars],
  )
  const gridGroups = useMemo(
    () =>
      meta.questions
        .filter((q) => q.kind === 'grid')
        .map((q) => ({
          id: q.id,
          label: q.label,
          items: q.items
            .map((it) => byName.get(it.column))
            .filter((v): v is Variable => !!v && isIndicator(v)),
        }))
        .filter((g) => g.items.length > 0),
    [meta.questions, byName],
  )
  const weightVars = useMemo(
    () => meta.variables.filter((v) => v.type === 'weight' && !v.hidden),
    [meta.variables],
  )

  // Any change to the setup clears the results so they always match the setup.
  function patch(p: Partial<SegmentationSpec>) {
    setDraft((d) => ({ ...d, ...p }))
    setResult(null)
    setSavedNote(null)
  }

  function toggleIndicator(n: string) {
    const has = draft.indicators.includes(n)
    patch({
      indicators: has
        ? draft.indicators.filter((x) => x !== n)
        : [...draft.indicators, n],
    })
  }

  function toggleGroup(cols: string[]) {
    const all = cols.every((c) => draft.indicators.includes(c))
    patch({
      indicators: all
        ? draft.indicators.filter((c) => !cols.includes(c))
        : [...new Set([...draft.indicators, ...cols])],
    })
  }

  const errors: string[] = []
  if (draft.indicators.length < 2)
    errors.push('Choose at least two indicator variables.')
  if (draft.classes_mode === 'auto') {
    if (!inRange(draft.max_classes))
      errors.push(
        `Maximum classes must be a whole number from ${MIN_CLASSES} to ${MAX_CLASSES}.`,
      )
  } else if (!inRange(draft.n_classes)) {
    errors.push(
      `Number of classes must be a whole number from ${MIN_CLASSES} to ${MAX_CLASSES}.`,
    )
  }
  const canRun = errors.length === 0

  async function run() {
    setBusy(true)
    setError(null)
    setSavedNote(null)
    try {
      setResult(await computeSegmentation(datasetId, draft))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run analysis')
    } finally {
      setBusy(false)
    }
  }

  // Re-run the saved analysis when the panel opens so its output persists after
  // switching to another table and back.
  useEffect(() => {
    const ok =
      draft.indicators.length >= 2 &&
      (draft.classes_mode === 'auto'
        ? inRange(draft.max_classes)
        : inRange(draft.n_classes))
    if (ok) run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function saveVariable() {
    if (!result) return
    const label = varLabel.trim() || 'Segment'
    setSaving(true)
    setError(null)
    try {
      const res = await saveSegmentationVariable(datasetId, draft, label)
      const next: SegmentationSpec = { ...draft, variable_name: res.variable_name }
      setDraft(next)
      onSave(title.trim() || 'Segmentation', next)
      onChanged(res.meta)
      setSavedNote(
        `Saved class membership as “${label}”. It is now a categorical variable you can use in crosstabs.`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save variable')
    } finally {
      setSaving(false)
    }
  }

  const maxSize = result
    ? Math.max(1, ...result.classes.map((c) => c.size_pct))
    : 1

  function renderIndicatorCheck(v: Variable) {
    return (
      <label key={v.name} className="ct-check">
        <input
          type="checkbox"
          checked={draft.indicators.includes(v.name)}
          onChange={() => toggleIndicator(v.name)}
        />
        {v.label}
      </label>
    )
  }

  return (
    <div className="ct-main driver-panel segment-panel">
      <div className="ct-builder-head">
        <label className="field ct-title-field">
          Title
          <input
            className="cell-input"
            placeholder="Untitled segmentation"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <span className="spacer" />
        <button
          className="primary"
          disabled={!dirty}
          onClick={() => onSave(title.trim() || 'Segmentation', draft)}
          title="Save this segmentation setup"
        >
          Save
        </button>
      </div>

      <div className="driver-builder">
        <fieldset className="driver-drivers">
          <legend>Indicators (segmenting questions)</legend>
          <p className="muted">
            Pick two or more categorical questions. Respondents are grouped by
            their answer pattern. Each indicator should have 2 to 12 answer
            categories.
          </p>
          <div className="driver-varlist">
            {indicatorVars.length === 0 && (
              <p className="muted">No categorical variables available.</p>
            )}
            {standalone.map(renderIndicatorCheck)}
            {gridGroups.map((g) => {
              const cols = g.items.map((v) => v.name)
              const all = cols.every((c) => draft.indicators.includes(c))
              return (
                <div key={g.id} className="driver-grid-group">
                  <label className="ct-check driver-group-title">
                    <input
                      type="checkbox"
                      checked={all}
                      onChange={() => toggleGroup(cols)}
                    />
                    {g.label}{' '}
                    <span className="muted">(grid, {cols.length} items)</span>
                  </label>
                  {g.items.map((v) => (
                    <label key={v.name} className="ct-check driver-grid-item">
                      <input
                        type="checkbox"
                        checked={draft.indicators.includes(v.name)}
                        onChange={() => toggleIndicator(v.name)}
                      />
                      {v.label}
                    </label>
                  ))}
                </div>
              )
            })}
          </div>
        </fieldset>

        <fieldset className="driver-drivers">
          <legend>Number of classes</legend>
          <label className="ct-check">
            <input
              type="radio"
              name="segment-mode"
              checked={draft.classes_mode === 'auto'}
              onChange={() => patch({ classes_mode: 'auto' })}
            />
            Suggest the number of classes (lowest BIC up to the maximum)
          </label>
          {draft.classes_mode === 'auto' && (
            <label className="field">
              Maximum classes to try
              <input
                type="number"
                min={MIN_CLASSES}
                max={MAX_CLASSES}
                value={draft.max_classes}
                onChange={(e) => patch({ max_classes: Number(e.target.value) })}
              />
            </label>
          )}
          <label className="ct-check">
            <input
              type="radio"
              name="segment-mode"
              checked={draft.classes_mode === 'fixed'}
              onChange={() => patch({ classes_mode: 'fixed' })}
            />
            Use a fixed number of classes
          </label>
          {draft.classes_mode === 'fixed' && (
            <label className="field">
              Classes
              <input
                type="number"
                min={MIN_CLASSES}
                max={MAX_CLASSES}
                value={draft.n_classes}
                onChange={(e) => patch({ n_classes: Number(e.target.value) })}
              />
            </label>
          )}
        </fieldset>

        <label className="field">
          Weight
          <select
            value={draft.weight ?? ''}
            onChange={(e) => patch({ weight: e.target.value || null })}
          >
            <option value="">Unweighted</option>
            {weightVars.map((v) => (
              <option key={v.name} value={v.name}>
                {v.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          Filter
          <select
            value={draft.filter_id ?? ''}
            onChange={(e) => patch({ filter_id: e.target.value || null })}
          >
            <option value="">No filter (everyone)</option>
            {meta.filters.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>

        {errors.length > 0 && (
          <ul className="driver-warnings">
            {errors.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        <div>
          <button className="primary" disabled={!canRun || busy} onClick={run}>
            {busy ? 'Running…' : 'Run analysis'}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>

      {result && (
        <div className="driver-results">
          <p>
            <strong>
              {result.k} classes
              {result.k_mode === 'auto' ? ' (suggested by BIC)' : ' (fixed)'}
            </strong>
          </p>

          <table className="crosstab driver-table">
            <thead>
              <tr>
                <th>Class</th>
                <th>Size</th>
                <th className="num">Size %</th>
              </tr>
            </thead>
            <tbody>
              {result.classes.map((c) => (
                <tr key={c.number}>
                  <td>Class {c.number}</td>
                  <td className="driver-bar-cell">
                    <span
                      className="driver-bar"
                      style={{ width: `${(c.size_pct / maxSize) * 100}%` }}
                    />
                  </td>
                  <td className="num">{c.size_pct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.k_mode === 'auto' && (
            <>
              <p className="segment-subhead">
                <strong>Fit by number of classes</strong>
              </p>
              <table className="crosstab driver-table">
                <thead>
                  <tr>
                    <th>Classes</th>
                    <th className="num">Log-likelihood</th>
                    <th className="num">Parameters</th>
                    <th className="num">AIC</th>
                    <th className="num">BIC</th>
                    <th className="num">Entropy R²</th>
                  </tr>
                </thead>
                <tbody>
                  {result.fit.map((f) => {
                    const chosen = f.k === result.k
                    return (
                      <tr key={f.k}>
                        <td>
                          {chosen ? <strong>{f.k} (chosen)</strong> : f.k}
                        </td>
                        <td className="num">{f.log_likelihood.toFixed(1)}</td>
                        <td className="num">{f.npar}</td>
                        <td className="num">{f.aic.toFixed(1)}</td>
                        <td className="num">{f.bic.toFixed(1)}</td>
                        <td className="num">
                          {f.entropy_r2 == null ? '' : f.entropy_r2.toFixed(3)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </>
          )}

          {result.profiles.map((p) => (
            <div key={p.name}>
              <p className="segment-subhead">
                <strong>{p.label}</strong>
              </p>
              <div style={{ overflowX: 'auto' }}>
                <table className="crosstab driver-table">
                  <thead>
                    <tr>
                      <th>Answer</th>
                      <th className="num">Total %</th>
                      {result.classes.map((c) => (
                        <Fragment key={c.number}>
                          <th className="num">Class {c.number} %</th>
                          <th className="num">Index</th>
                        </Fragment>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {p.rows.map((row) => (
                      <tr key={row.label}>
                        <td>{row.label}</td>
                        <td className="num">{row.overall_pct.toFixed(1)}%</td>
                        {row.class_pcts.map((pct, i) => {
                          const idx = row.class_index[i]
                          const high = idx != null && idx >= HIGH_INDEX
                          return (
                            <Fragment key={i}>
                              <td className="num">{pct.toFixed(1)}%</td>
                              <td className="num">
                                {idx == null ? (
                                  ''
                                ) : high ? (
                                  <strong>{Math.round(idx)}</strong>
                                ) : (
                                  Math.round(idx)
                                )}
                              </td>
                            </Fragment>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <p className="ct-caption">
            Latent class segmentation · {result.k} classes
            {result.entropy_r2 != null &&
              ` · Entropy R² = ${result.entropy_r2.toFixed(3)}`}
            {' · '}Filter: {result.filter_label ?? 'None'}
            {' · '}
            {result.weighted
              ? `Weighted – ${result.weight_label}`
              : 'Unweighted'}
            {' · '}Base n = {result.base_n}
            {result.weighted &&
              result.eff_base_n != null &&
              ` · Effective n = ${Math.round(result.eff_base_n)}`}
            {' · '}Classified n = {result.classified_n}
            {result.excluded_missing > 0 &&
              ` · ${result.excluded_missing} excluded for missing answers`}
          </p>

          <div className="driver-builder">
            <label className="field">
              Variable label
              <input
                className="cell-input"
                value={varLabel}
                onChange={(e) => setVarLabel(e.target.value)}
              />
            </label>
            <div>
              <button
                className="primary"
                disabled={!result || saving}
                onClick={saveVariable}
                title="Save each respondent's class as a categorical variable"
              >
                {saving ? 'Saving…' : 'Save class membership as variable'}
              </button>
            </div>
            {savedNote && <p className="muted">{savedNote}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
