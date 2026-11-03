import { useState } from 'react'
import { ConditionRow } from './FiltersManager'
import {
  createRulesVariable,
  type Condition,
  type DatasetMeta,
} from '../api'
import { useBackdropDismiss } from '../useBackdropDismiss'

interface RuleDraft {
  id: string
  conditions: Condition[]
  label: string
}

export function RuleDialog({
  meta,
  onClose,
  onCreated,
}: {
  meta: DatasetMeta
  onClose: () => void
  onCreated: (m: DatasetMeta) => void
}) {
  const backdrop = useBackdropDismiss()

  function blankCondition(): Condition {
    const v = meta.variables.find((x) => !x.hidden && x.type !== 'weight')
    const type = v?.type ?? 'categorical'
    return {
      variable: v?.name ?? '',
      operator: type === 'numeric' ? 'ge' : 'in',
      values: [],
      number: null,
      number2: null,
    }
  }

  const [rules, setRules] = useState<RuleDraft[]>([
    { id: crypto.randomUUID(), conditions: [blankCondition()], label: '' },
  ])
  const [elseLabel, setElseLabel] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function patchRule(id: string, patch: Partial<RuleDraft>) {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }
  function setConds(id: string, conditions: Condition[]) {
    patchRule(id, { conditions })
  }

  const named = rules.filter((r) => r.label.trim())
  const canCreate = named.length > 0 && !busy

  async function create() {
    const labels = named.map((r) => r.label.trim())
    if (new Set(labels).size !== labels.length) {
      setError('Rule output names must be unique.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const m = await createRulesVariable(meta.id, {
        rules: named.map((r) => ({
          conditions: r.conditions,
          label: r.label.trim(),
        })),
        else_label: elseLabel.trim() || null,
        new_label: name.trim() || 'Rule variable',
      })
      onCreated(m)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create variable')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" {...backdrop(onClose)}>
      <div className="modal rules-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>New variable from logic (IF / AND / OR)</h3>
          <button className="expand" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="muted">
          Each rule assigns an output category to respondents matching its
          conditions. Rules are checked top to bottom — the first match wins.
        </p>

        <div className="rules-list">
          {rules.map((rule, ri) => (
            <div key={rule.id} className="rule-card">
              <div className="rule-head">
                <strong>{ri === 0 ? 'IF' : 'ELSE IF'}</strong>
                <span className="spacer" />
                <button
                  className="danger"
                  disabled={rules.length === 1}
                  onClick={() =>
                    setRules((prev) => prev.filter((r) => r.id !== rule.id))
                  }
                >
                  Remove rule
                </button>
              </div>

              {rule.conditions.map((c, ci) => (
                <div key={ci}>
                  {ci > 0 && (
                    <div className="connector-row">
                      <button
                        type="button"
                        className={
                          (c.connector ?? 'and') === 'and'
                            ? 'connector active'
                            : 'connector'
                        }
                        onClick={() =>
                          setConds(
                            rule.id,
                            rule.conditions.map((x, idx) =>
                              idx === ci ? { ...x, connector: 'and' } : x,
                            ),
                          )
                        }
                      >
                        AND
                      </button>
                      <button
                        type="button"
                        className={
                          (c.connector ?? 'and') === 'or'
                            ? 'connector active'
                            : 'connector'
                        }
                        onClick={() =>
                          setConds(
                            rule.id,
                            rule.conditions.map((x, idx) =>
                              idx === ci ? { ...x, connector: 'or' } : x,
                            ),
                          )
                        }
                      >
                        OR
                      </button>
                    </div>
                  )}
                  <ConditionRow
                    meta={meta}
                    condition={c}
                    onChange={(patch) =>
                      setConds(
                        rule.id,
                        rule.conditions.map((x, idx) =>
                          idx === ci ? { ...x, ...patch } : x,
                        ),
                      )
                    }
                    onRemove={() =>
                      setConds(
                        rule.id,
                        rule.conditions.filter((_, idx) => idx !== ci),
                      )
                    }
                  />
                </div>
              ))}
              <button
                onClick={() =>
                  setConds(rule.id, [...rule.conditions, blankCondition()])
                }
              >
                + Add condition
              </button>

              <label className="field rule-then">
                THEN set category to
                <input
                  className="cell-input"
                  placeholder="Category name"
                  value={rule.label}
                  onChange={(e) => patchRule(rule.id, { label: e.target.value })}
                />
              </label>
            </div>
          ))}
        </div>

        <button
          onClick={() =>
            setRules((prev) => [
              ...prev,
              { id: crypto.randomUUID(), conditions: [blankCondition()], label: '' },
            ])
          }
        >
          + Add rule
        </button>

        <label className="field" style={{ marginTop: '0.75rem' }}>
          Everyone else (optional)
          <input
            className="cell-input"
            placeholder="Leave blank to make unmatched respondents missing"
            value={elseLabel}
            onChange={(e) => setElseLabel(e.target.value)}
          />
        </label>

        <label className="field">
          New variable name
          <input
            className="cell-input"
            placeholder="Rule variable"
            value={name}
            onChange={(e) => setName(e.target.value)}
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
