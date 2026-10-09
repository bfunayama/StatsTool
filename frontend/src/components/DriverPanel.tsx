import { useEffect, useMemo, useState } from 'react'
import {
  computeDrivers,
  type DatasetMeta,
  type DriverResponse,
  type DriverSpec,
  type Variable,
} from '../api'

interface Props {
  datasetId: string
  meta: DatasetMeta
  name: string
  spec: DriverSpec
  onSave: (name: string, spec: DriverSpec) => void
}

const METHOD_LABELS: Record<DriverSpec['method'], string> = {
  relative_weights: 'Relative weights (Johnson)',
  shapley: 'Shapley / LMG',
  logit: 'Binary logit (relative weights)',
  ordered_logit: 'Ordered logit (relative weights)',
}

const METHOD_GUIDANCE: Record<DriverSpec['method'], string> = {
  relative_weights:
    'Use a numeric outcome and numeric or binary drivers. Handles correlated drivers well.',
  shapley:
    'Exact relative importance by averaging over all predictor orderings (up to 12 drivers). Numeric outcome.',
  logit:
    'For a two-category outcome (e.g. aware / not aware). Importance comes from a weighted logistic model.',
  ordered_logit:
    'For an ordered-scale outcome (e.g. a 1–5 rating). Importance comes from a proportional-odds model.',
}

export function defaultDriverSpec(): DriverSpec {
  return {
    outcome: '',
    driver_kind: 'variables',
    driver_question: '',
    driver_variables: [],
    method: 'relative_weights',
    weight: null,
    filter_id: null,
    trim_outliers: false,
    outlier_pct: 5,
  }
}

function varIsNumeric(v: Variable): boolean {
  if (v.type === 'numeric') return true
  const coded = (v.values ?? []).filter((a) => !a.missing && a.value != null)
  return coded.length >= 2
}

// Drivers used to be a grid OR a variable set; now they are one unified list of
// columns. Expand any saved grid-mode spec into its item columns.
function normalizeSpec(spec: DriverSpec, meta: DatasetMeta): DriverSpec {
  if (spec.driver_kind === 'question' && spec.driver_question) {
    const q = meta.questions.find((x) => x.id === spec.driver_question)
    if (q)
      return {
        ...spec,
        driver_kind: 'variables',
        driver_variables: q.items.map((it) => it.column),
      }
  }
  return { ...spec, driver_kind: 'variables' }
}

export function DriverPanel({
  datasetId,
  meta,
  name,
  spec,
  onSave,
}: Props) {
  const [title, setTitle] = useState(name)
  const [draft, setDraft] = useState<DriverSpec>(() => normalizeSpec(spec, meta))
  const [result, setResult] = useState<DriverResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty =
    title.trim() !== name || JSON.stringify(draft) !== JSON.stringify(spec)

  const byName = useMemo(() => {
    const m = new Map<string, Variable>()
    meta.variables.forEach((v) => m.set(v.name, v))
    return m
  }, [meta.variables])

  const numericVars = useMemo(
    () =>
      meta.variables.filter(
        (v) => !v.question_id && v.type !== 'weight' && !v.hidden && varIsNumeric(v),
      ),
    [meta.variables],
  )
  const gridQuestions = useMemo(
    () => meta.questions.filter((q) => q.kind === 'grid'),
    [meta.questions],
  )
  const weightVars = useMemo(
    () => meta.variables.filter((v) => v.type === 'weight' && !v.hidden),
    [meta.variables],
  )

  // Drivers are always a set of columns now (grid items are columns too).
  function patch(p: Partial<DriverSpec>) {
    setDraft((d) => ({ ...d, ...p, driver_kind: 'variables' }))
    setResult(null)
  }

  function toggleDriverVar(nameToToggle: string) {
    const has = draft.driver_variables.includes(nameToToggle)
    patch({
      driver_variables: has
        ? draft.driver_variables.filter((n) => n !== nameToToggle)
        : [...draft.driver_variables, nameToToggle],
    })
  }

  function toggleGrid(cols: string[]) {
    const all = cols.every((c) => draft.driver_variables.includes(c))
    patch({
      driver_variables: all
        ? draft.driver_variables.filter((c) => !cols.includes(c))
        : [...new Set([...draft.driver_variables, ...cols])],
    })
  }

  const selectedDrivers = draft.driver_variables
  const outcomeVar = draft.outcome ? byName.get(draft.outcome) : undefined
  const outcomeLevels = outcomeVar
    ? (outcomeVar.values ?? []).filter((a) => !a.missing).length
    : 0

  // Blocking errors.
  const errors: string[] = []
  if (!draft.outcome) errors.push('Choose an outcome variable.')
  if (selectedDrivers.length < 2) errors.push('Choose at least two drivers.')
  if (draft.outcome && selectedDrivers.includes(draft.outcome))
    errors.push('The outcome is also selected as a driver — remove it.')
  if (draft.method === 'shapley' && selectedDrivers.length > 12)
    errors.push(
      `Shapley handles up to 12 drivers; you have ${selectedDrivers.length}. Use relative weights or remove some.`,
    )
  if (draft.method === 'logit' && outcomeVar && outcomeLevels > 2)
    errors.push(
      'Binary logit needs a two-category outcome — pick a binary variable or band this one to two categories.',
    )
  if (draft.method === 'ordered_logit' && outcomeVar && outcomeLevels > 0) {
    if (outcomeLevels < 3)
      errors.push(
        'Ordered logit needs 3+ ordered categories — use binary logit for a two-category outcome.',
      )
    else if (outcomeLevels > 15)
      errors.push(
        'Ordered logit expects a short ordered scale; this outcome has too many categories. Use relative weights.',
      )
  }

  // Non-blocking guidance based on the chosen variable types.
  const notes: string[] = []
  if (outcomeVar && outcomeVar.type === 'categorical') {
    if (outcomeLevels <= 2) {
      if (draft.method !== 'logit')
        notes.push(
          `Outcome “${outcomeVar.label}” is categorical — it is treated as a 0/1 outcome (a linear probability model). Switch the method to Binary logit for a better fit.`,
        )
    } else {
      notes.push(
        `Outcome “${outcomeVar.label}” is categorical with ${outcomeLevels} levels — the analysis uses its numeric codes, which only makes sense for an ordered scale.`,
      )
    }
  }
  const nominalDrivers = selectedDrivers.filter((n) => {
    const v = byName.get(n)
    if (!v || v.type !== 'categorical') return false
    return (v.values ?? []).filter((a) => !a.missing).length > 2
  })
  if (nominalDrivers.length > 0)
    notes.push(
      `${nominalDrivers.length} categorical driver${nominalDrivers.length === 1 ? ' is' : 's are'} used via numeric codes — fine for ordered scales, not for unordered categories.`,
    )

  // Recommend a method from the chosen variable types.
  let recommended: { method: DriverSpec['method']; why: string } | null = null
  if (outcomeVar) {
    const binary =
      outcomeVar.type === 'binary' ||
      (outcomeVar.type === 'categorical' && outcomeLevels === 2)
    const ordinal =
      outcomeVar.type === 'categorical' &&
      outcomeLevels >= 3 &&
      outcomeLevels <= 15
    if (binary) {
      recommended = { method: 'logit', why: 'your outcome has two categories' }
    } else if (ordinal) {
      recommended = {
        method: 'ordered_logit',
        why: `your outcome is an ordered scale with ${outcomeLevels} categories`,
      }
    } else if (selectedDrivers.length >= 2 && selectedDrivers.length <= 10) {
      recommended = {
        method: 'shapley',
        why: 'a numeric outcome with a small set of drivers (exact importance)',
      }
    } else {
      recommended = {
        method: 'relative_weights',
        why: 'a numeric outcome with many correlated drivers',
      }
    }
  }

  const canRun = errors.length === 0

  async function run() {
    setBusy(true)
    setError(null)
    try {
      setResult(await computeDrivers(datasetId, draft))
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
      draft.outcome &&
      draft.driver_variables.length >= 2 &&
      !draft.driver_variables.includes(draft.outcome)
    if (ok) run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const maxPct = result
    ? Math.max(1, ...result.rows.map((r) => Math.abs(r.signed_pct)))
    : 1

  return (
    <div className="ct-main driver-panel">
      <div className="ct-builder-head">
        <label className="field ct-title-field">
          Title
          <input
            className="cell-input"
            placeholder="Untitled driver analysis"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <span className="spacer" />
        <button
          className="primary"
          disabled={!dirty}
          onClick={() => onSave(title.trim() || 'Driver analysis', draft)}
          title="Save this driver analysis"
        >
          Save
        </button>
      </div>

      <div className="driver-builder">
        <label className="field">
          Outcome (dependent)
          <select
            value={draft.outcome}
            onChange={(e) => patch({ outcome: e.target.value })}
          >
            <option value="">Choose a numeric variable…</option>
            {numericVars.map((v) => (
              <option key={v.name} value={v.name}>
                {v.label}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="driver-drivers">
          <legend>Drivers (predictors)</legend>
          <p className="muted">
            Pick two or more numeric predictors. Grid items and standalone
            variables can be mixed.
          </p>
          <div className="driver-varlist">
            {numericVars.length === 0 && gridQuestions.length === 0 && (
              <p className="muted">No numeric variables available.</p>
            )}
            {numericVars.map((v) => (
              <label key={v.name} className="ct-check">
                <input
                  type="checkbox"
                  checked={selectedDrivers.includes(v.name)}
                  onChange={() => toggleDriverVar(v.name)}
                />
                {v.label}
              </label>
            ))}
            {gridQuestions.map((q) => {
              const cols = q.items.map((it) => it.column)
              const all = cols.every((c) => selectedDrivers.includes(c))
              return (
                <div key={q.id} className="driver-grid-group">
                  <label className="ct-check driver-group-title">
                    <input
                      type="checkbox"
                      checked={all}
                      onChange={() => toggleGrid(cols)}
                    />
                    {q.label}{' '}
                    <span className="muted">(grid, {cols.length} items)</span>
                  </label>
                  {q.items.map((it) => (
                    <label key={it.column} className="ct-check driver-grid-item">
                      <input
                        type="checkbox"
                        checked={selectedDrivers.includes(it.column)}
                        onChange={() => toggleDriverVar(it.column)}
                      />
                      {it.label}
                    </label>
                  ))}
                </div>
              )
            })}
          </div>
        </fieldset>

        <label className="field">
          Method
          <select
            value={draft.method}
            onChange={(e) =>
              patch({ method: e.target.value as DriverSpec['method'] })
            }
          >
            {(
              ['relative_weights', 'shapley', 'logit', 'ordered_logit'] as const
            ).map((m) => (
              <option key={m} value={m}>
                {METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <p className="muted driver-guidance">{METHOD_GUIDANCE[draft.method]}</p>
        {recommended && recommended.method !== draft.method && (
          <p className="driver-recommend">
            Recommended: <strong>{METHOD_LABELS[recommended.method]}</strong> —{' '}
            {recommended.why}.{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => patch({ method: recommended!.method })}
            >
              Use this
            </button>
          </p>
        )}
        {recommended && recommended.method === draft.method && (
          <p className="muted driver-recommend">
            ✓ A good fit for the variables you&apos;ve chosen.
          </p>
        )}

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

        <label className="ct-check">
          <input
            type="checkbox"
            checked={draft.trim_outliers}
            onChange={(e) => patch({ trim_outliers: e.target.checked })}
          />
          Remove 5% of outliers (Mahalanobis distance)
        </label>

        {errors.length > 0 && (
          <ul className="driver-warnings">
            {errors.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {notes.length > 0 && (
          <ul className="driver-notes">
            {notes.map((w) => (
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
          <table className="crosstab driver-table">
            <thead>
              <tr>
                <th>Driver</th>
                <th>Importance</th>
                <th className="num">Importance %</th>
                <th className="num">Correlation</th>
                <th className="num">Beta</th>
                <th className="num">Mean</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => {
                const neg = r.signed_pct < 0
                const width = (Math.abs(r.signed_pct) / maxPct) * 100
                return (
                  <tr key={r.name}>
                    <td>{r.label}</td>
                    <td className="driver-bar-cell">
                      <span
                        className={`driver-bar${neg ? ' neg' : ''}`}
                        style={{ width: `${width}%` }}
                      />
                    </td>
                    <td className="num">
                      {neg ? '−' : ''}
                      {Math.abs(r.signed_pct).toFixed(1)}%
                    </td>
                    <td className="num">{r.correlation.toFixed(2)}</td>
                    <td className="num">{r.beta.toFixed(2)}</td>
                    <td className="num">
                      {r.mean == null ? '' : r.mean.toFixed(2)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="ct-caption">
            {METHOD_LABELS[result.method as DriverSpec['method']] ??
              result.method}
            {' · '}
            {result.method === 'logit' || result.method === 'ordered_logit'
              ? 'Pseudo-R²'
              : 'R²'}{' '}
            = {result.r2.toFixed(3)}
            {result.adj_r2 != null && ` (adj. ${result.adj_r2.toFixed(3)})`}
            {' · '}Filter: {result.filter_label ?? 'None'}
            {' · '}
            {result.weighted
              ? `Weighted – ${result.weight_label}`
              : 'Unweighted'}
            {' · '}Base n = {result.base_n}
            {result.weighted &&
              result.eff_base_n != null &&
              ` · Effective n = ${Math.round(result.eff_base_n)}`}
            {result.trimmed > 0 && ` · ${result.trimmed} outliers removed`}
          </p>
        </div>
      )}
    </div>
  )
}
