import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  runCrosstab,
  saveCrosstabs,
  type CrosstabNode,
  type CrosstabResponse,
  type CrosstabRowSpec,
  type DatasetMeta,
  type SavedCrosstabSpec,
} from '../api'

interface Props {
  meta: DatasetMeta
  onChanged: (meta: DatasetMeta) => void
}

// Statistics the user can toggle. All are derived from cell counts + bases.
type CellStat = 'count' | 'col_pct' | 'row_pct' | 'total_pct'
type SummaryRowStat = 'base_n' | 'total_count' | 'total_sum' | 'mean'
type SummaryColStat = 'row_n'

const CELL_STATS: { key: CellStat; label: string }[] = [
  { key: 'count', label: 'Count' },
  { key: 'col_pct', label: 'Column %' },
  { key: 'row_pct', label: 'Row %' },
  { key: 'total_pct', label: 'Total %' },
]
const SUMMARY_ROW_STATS: { key: SummaryRowStat; label: string }[] = [
  { key: 'base_n', label: 'Base n' },
  { key: 'total_count', label: 'Column n' },
  { key: 'total_sum', label: 'Total Sum' },
  { key: 'mean', label: 'Mean' },
]
const SUMMARY_COL_STATS: { key: SummaryColStat; label: string }[] = [
  { key: 'row_n', label: 'Row n' },
]
// Total Sum / Mean only make sense when the row has numeric values.
const NUMERIC_SUMMARY_ROW: Set<SummaryRowStat> = new Set(['total_sum', 'mean'])

function fmtPct(value: number | null): string {
  return value === null ? '' : `${value.toFixed(1)}%`
}

function fmtNumber(value: number | null): string {
  if (value === null) return ''
  return Number.isInteger(value) ? `${value}` : value.toFixed(2)
}

// Encode a row choice as "v:<name>" (variable) or "q:<id>" (grouped variable).
function decodeRow(value: string): CrosstabRowSpec | null {
  if (value.startsWith('v:')) return { kind: 'variable', ref: value.slice(2) }
  if (value.startsWith('q:')) return { kind: 'question', ref: value.slice(2) }
  return null
}

function encodeRow(row: CrosstabRowSpec): string {
  return `${row.kind === 'question' ? 'q' : 'v'}:${row.ref}`
}

// --- Saved-crosstab tree helpers (immutable operations on the node list) ---
function findNode(nodes: CrosstabNode[], id: string): CrosstabNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const inChild = findNode(node.children, id)
    if (inChild) return inChild
  }
  return null
}

function updateNode(
  nodes: CrosstabNode[],
  id: string,
  patch: Partial<CrosstabNode>,
): CrosstabNode[] {
  return nodes.map((node) =>
    node.id === id
      ? { ...node, ...patch }
      : { ...node, children: updateNode(node.children, id, patch) },
  )
}

function removeNode(nodes: CrosstabNode[], id: string): CrosstabNode[] {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) => ({ ...node, children: removeNode(node.children, id) }))
}

function insertNode(
  nodes: CrosstabNode[],
  parentId: string | null,
  node: CrosstabNode,
): CrosstabNode[] {
  if (parentId === null) return [...nodes, node]
  return nodes.map((n) =>
    n.id === parentId
      ? { ...n, children: [...n.children, node] }
      : { ...n, children: insertNode(n.children, parentId, node) },
  )
}

export function CrosstabView({ meta, onChanged }: Props) {
  const memberless = useMemo(
    () => meta.variables.filter((v) => !v.question_id),
    [meta.variables],
  )
  const multiQuestions = useMemo(
    () => (meta.questions ?? []).filter((q) => q.kind === 'multi'),
    [meta.questions],
  )

  const [rowValue, setRowValue] = useState('')
  const [colValue, setColValue] = useState('')
  const [filterId, setFilterId] = useState('')
  const [result, setResult] = useState<CrosstabResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cellStats, setCellStats] = useState<Set<CellStat>>(
    () => new Set<CellStat>(['count', 'col_pct']),
  )
  const [summaryRows, setSummaryRows] = useState<Set<SummaryRowStat>>(
    () => new Set<SummaryRowStat>(['base_n']),
  )
  const [summaryCols, setSummaryCols] = useState<Set<SummaryColStat>>(
    () => new Set<SummaryColStat>(),
  )

  // Saved-crosstab tree (folders + saved tables), persisted on the dataset.
  const [tree, setTree] = useState<CrosstabNode[]>(meta.crosstabs ?? [])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [treeError, setTreeError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [titleDraft, setTitleDraft] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(
    () => Number(localStorage.getItem('statstool.ctSidebar')) || 240,
  )

  useEffect(() => {
    localStorage.setItem('statstool.ctSidebar', String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    setTree(meta.crosstabs ?? [])
  }, [meta.crosstabs])

  function persistTree(next: CrosstabNode[]) {
    setTree(next)
    setTreeError(null)
    saveCrosstabs(meta.id, next)
      .then(onChanged)
      .catch((err) =>
        setTreeError(err instanceof Error ? err.message : 'Could not save'),
      )
  }

  function currentSpec(): SavedCrosstabSpec | null {
    const row = decodeRow(rowValue)
    if (!row || !colValue) return null
    return {
      row,
      column: colValue,
      filter_id: filterId || null,
      display: {
        cell_stats: CELL_STATS.filter((s) => cellStats.has(s.key)).map((s) => s.key),
        summary_rows: SUMMARY_ROW_STATS.filter((s) => summaryRows.has(s.key)).map(
          (s) => s.key,
        ),
        summary_cols: SUMMARY_COL_STATS.filter((s) => summaryCols.has(s.key)).map(
          (s) => s.key,
        ),
      },
    }
  }

  function loadSpec(spec: SavedCrosstabSpec) {
    setRowValue(encodeRow(spec.row))
    setColValue(spec.column)
    setFilterId(spec.filter_id ?? '')
    setCellStats(new Set(spec.display.cell_stats as CellStat[]))
    setSummaryRows(new Set(spec.display.summary_rows as SummaryRowStat[]))
    setSummaryCols(new Set(spec.display.summary_cols as SummaryColStat[]))
  }

  const selectedNode = selectedId ? findNode(tree, selectedId) : null
  const builderSpec = currentSpec()
  const dirty =
    selectedNode?.spec != null &&
    (JSON.stringify(builderSpec) !== JSON.stringify(selectedNode.spec) ||
      titleDraft.trim() !== selectedNode.name)

  function selectCrosstab(node: CrosstabNode) {
    if (!node.spec) return
    loadSpec(node.spec)
    setSelectedId(node.id)
    setTitleDraft(node.name)
  }

  function closeTable() {
    setSelectedId(null)
    setTitleDraft('')
  }

  function newFolder() {
    const node: CrosstabNode = {
      id: crypto.randomUUID(),
      name: 'New folder',
      kind: 'folder',
      children: [],
      spec: null,
      version: 1,
    }
    persistTree(insertNode(tree, activeFolderId, node))
    setActiveFolderId(node.id)
    setEditingId(node.id)
    setEditingName(node.name)
  }

  function newTable() {
    const spec = currentSpec()
    if (!spec) return
    const auto = colValue
      ? `${rowLabelFor(rowValue)} by ${colLabelFor(colValue)}`
      : rowLabelFor(rowValue)
    const name = titleDraft.trim() || auto
    const node: CrosstabNode = {
      id: crypto.randomUUID(),
      name,
      kind: 'crosstab',
      children: [],
      spec,
      version: 1,
    }
    persistTree(insertNode(tree, activeFolderId, node))
    setSelectedId(node.id)
    setTitleDraft(name)
  }

  function saveTable() {
    if (!selectedId || !selectedNode) return
    const spec = currentSpec()
    if (!spec) return
    persistTree(
      updateNode(tree, selectedId, {
        spec,
        name: titleDraft.trim() || selectedNode.name,
      }),
    )
  }

  function startRename(node: CrosstabNode) {
    setEditingId(node.id)
    setEditingName(node.name)
  }

  function commitRename() {
    if (editingId && editingName.trim())
      persistTree(updateNode(tree, editingId, { name: editingName.trim() }))
    setEditingId(null)
  }

  function deleteNode(node: CrosstabNode) {
    const what = node.kind === 'folder' ? 'folder and everything in it' : 'table'
    if (!confirm(`Delete "${node.name}" (${what})?`)) return
    persistTree(removeNode(tree, node.id))
    if (selectedId && findNode([node], selectedId)) setSelectedId(null)
  }

  function rowLabelFor(value: string): string {
    const row = decodeRow(value)
    if (!row) return value
    if (row.kind === 'question')
      return meta.questions.find((q) => q.id === row.ref)?.label ?? row.ref
    return meta.variables.find((v) => v.name === row.ref)?.label ?? row.ref
  }

  function colLabelFor(name: string): string {
    return meta.variables.find((v) => v.name === name)?.label ?? name
  }

  useEffect(() => {
    const row = decodeRow(rowValue)
    if (!row || !colValue) {
      setResult(null)
      setError(null)
      return
    }
    let ignore = false
    setLoading(true)
    setError(null)
    runCrosstab(meta.id, row, colValue, filterId || null)
      .then((res) => {
        if (!ignore) setResult(res)
      })
      .catch((err) => {
        if (!ignore) {
          setResult(null)
          setError(err instanceof Error ? err.message : 'Crosstab failed')
        }
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
  }, [meta.id, rowValue, colValue, filterId])

  // Row/column totals derived from cell counts (used for row %, total %, margins).
  const margins = useMemo(() => {
    if (!result) return null
    const rowTotals = result.cells.map((row) =>
      row.reduce((sum, cell) => sum + cell.count, 0),
    )
    const colTotals = result.columns.map((_c, ci) =>
      result.cells.reduce((sum, row) => sum + row[ci].count, 0),
    )
    // Sum of (value × count) and count of numeric responses, per column.
    const colSums = result.columns.map((_c, ci) =>
      result.cells.reduce((sum, row, ri) => {
        const value = result.row_values[ri]
        return value === null ? sum : sum + value * row[ci].count
      }, 0),
    )
    const colValidCounts = result.columns.map((_c, ci) =>
      result.cells.reduce((sum, row, ri) => {
        const value = result.row_values[ri]
        return value === null ? sum : sum + row[ci].count
      }, 0),
    )
    const hasNumeric = result.row_values.some((v) => v !== null)
    const grandCount = colTotals.reduce((a, b) => a + b, 0)
    const grandSum = colSums.reduce((a, b) => a + b, 0)
    const grandValid = colValidCounts.reduce((a, b) => a + b, 0)
    return {
      rowTotals,
      colTotals,
      colSums,
      colValidCounts,
      hasNumeric,
      grandCount,
      grandSum,
      grandMean: grandValid ? grandSum / grandValid : null,
    }
  }, [result])

  function toggle<T>(setter: (fn: (prev: Set<T>) => Set<T>) => void, key: T) {
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Ordered list of cell-stat lines to render inside one cell.
  function cellLines(count: number, colBase: number, rowTotal: number) {
    const lines: { key: CellStat; label: string; text: string }[] = []
    for (const stat of CELL_STATS) {
      if (!cellStats.has(stat.key)) continue
      let text = ''
      if (stat.key === 'count') text = `${count}`
      else if (stat.key === 'col_pct')
        text = fmtPct(colBase ? (count / colBase) * 100 : null)
      else if (stat.key === 'row_pct')
        text = fmtPct(rowTotal ? (count / rowTotal) * 100 : null)
      else if (stat.key === 'total_pct')
        text = fmtPct(
          result && result.total_base
            ? (count / result.total_base) * 100
            : null,
        )
      lines.push({ key: stat.key, label: stat.label, text })
    }
    return lines
  }

  // Value of a summary-row statistic for one banner column.
  function summaryRowValue(key: SummaryRowStat, ci: number): string {
    if (!margins || !result) return ''
    if (key === 'base_n') return fmtNumber(result.columns[ci].base)
    if (key === 'total_count') return fmtNumber(margins.colTotals[ci])
    if (key === 'total_sum') return fmtNumber(margins.colSums[ci])
    const valid = margins.colValidCounts[ci]
    return fmtNumber(valid ? margins.colSums[ci] / valid : null)
  }

  // Overall value of a summary-row statistic (shown in the summary column).
  function summaryRowCorner(key: SummaryRowStat): string {
    if (!margins || !result) return ''
    if (key === 'base_n') return fmtNumber(result.total_base)
    if (key === 'total_count') return fmtNumber(margins.grandCount)
    if (key === 'total_sum') return fmtNumber(margins.grandSum)
    return fmtNumber(margins.grandMean)
  }

  const numericOk = margins ? margins.hasNumeric : true
  const activeSummaryRows = SUMMARY_ROW_STATS.filter(
    (s) => summaryRows.has(s.key) && (numericOk || !NUMERIC_SUMMARY_ROW.has(s.key)),
  )
  const activeSummaryCols = SUMMARY_COL_STATS.filter((s) =>
    summaryCols.has(s.key),
  )
  const showCellLabels = cellStats.size > 1

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function startResize(e: ReactMouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    function onMove(ev: MouseEvent) {
      setSidebarWidth(Math.min(480, Math.max(160, startW + (ev.clientX - startX))))
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function renderNodes(nodes: CrosstabNode[], depth: number) {
    return nodes.flatMap((node) => {
      const isFolder = node.kind === 'folder'
      const isCollapsed = collapsed.has(node.id)
      const classes = [
        'ct-node',
        node.id === selectedId ? 'selected' : '',
        isFolder && node.id === activeFolderId ? 'active-folder' : '',
      ]
        .filter(Boolean)
        .join(' ')
      const row = (
        <div
          key={node.id}
          className={classes}
          style={{ paddingLeft: `${depth * 1.1 + 0.25}rem` }}
        >
          {isFolder ? (
            <button
              className="ct-twisty"
              onClick={() => toggleCollapse(node.id)}
              aria-label="Toggle folder"
            >
              {isCollapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="ct-twisty" />
          )}
          {editingId === node.id ? (
            <input
              className="ct-node-input"
              autoFocus
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setEditingId(null)
              }}
            />
          ) : (
            <button
              className={isFolder ? 'ct-node-name ct-folder' : 'ct-node-name'}
              onClick={() =>
                isFolder ? setActiveFolderId(node.id) : selectCrosstab(node)
              }
              onDoubleClick={() => startRename(node)}
              title={
                isFolder
                  ? 'Click to put new items here; double-click to rename'
                  : 'Open table; double-click to rename'
              }
            >
              {node.name}
            </button>
          )}
          <button
            className="ct-node-del"
            onClick={() => deleteNode(node)}
            title="Delete"
          >
            ✕
          </button>
        </div>
      )
      if (isFolder && !isCollapsed) {
        return [row, ...renderNodes(node.children, depth + 1)]
      }
      return [row]
    })
  }

  return (
    <div className="ct-layout">
      <aside className="ct-tree" style={{ width: sidebarWidth }}>
        <div className="ct-tree-head">
          <strong>Tables</strong>
          <span className="spacer" />
          <button onClick={newFolder} title="New folder">
            + Folder
          </button>
        </div>
        {treeError && <p className="error">{treeError}</p>}
        <div className="ct-tree-body">
          {tree.length === 0 && (
            <p className="muted ct-tree-empty">
              No saved tables yet. Build one, name it, then “Save as table”.
            </p>
          )}
          {renderNodes(tree, 0)}
          <button
            className={`ct-root-target${activeFolderId === null ? ' active-folder' : ''}`}
            onClick={() => setActiveFolderId(null)}
            title="New items go to the top level"
          >
            Top level
          </button>
        </div>
      </aside>

      <div
        className="ct-resizer"
        onMouseDown={startResize}
        role="separator"
        aria-orientation="vertical"
      />

      <div className="ct-main">
        <div className="ct-builder-head">
          <label className="field ct-title-field">
            Title
            <input
              className="cell-input"
              placeholder="Untitled table"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
            />
          </label>
          {selectedNode ? (
            <>
              {dirty && <span className="muted">Unsaved changes</span>}
              <button className="primary" disabled={!dirty} onClick={saveTable}>
                Save table
              </button>
              <button onClick={closeTable}>Close</button>
            </>
          ) : (
            <button
              className="primary"
              disabled={!builderSpec}
              onClick={newTable}
              title={
                builderSpec
                  ? 'Save the current setup as a table'
                  : 'Choose a row and column first'
              }
            >
              Save as table
            </button>
          )}
          <span className="spacer" />
          {loading && <span className="muted">Computing…</span>}
        </div>

        <div className="ct-controls">
        <label className="field">
          Row
          <select value={rowValue} onChange={(e) => setRowValue(e.target.value)}>
            <option value="">Choose a variable…</option>
            {multiQuestions.length > 0 && (
              <optgroup label="Grouped (Pick any)">
                {multiQuestions.map((q) => (
                  <option key={q.id} value={`q:${q.id}`}>
                    {q.label}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Variables">
              {memberless.map((v) => (
                <option key={v.name} value={`v:${v.name}`}>
                  {v.label}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="field">
          Column
          <select value={colValue} onChange={(e) => setColValue(e.target.value)}>
            <option value="">Choose a variable…</option>
            {memberless.map((v) => (
              <option key={v.name} value={v.name}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Filter
          <select value={filterId} onChange={(e) => setFilterId(e.target.value)}>
            <option value="">None (all respondents)</option>
            {meta.filters.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        {loading && <span className="muted">Computing…</span>}
      </div>

      <div className="ct-stat-groups">
        <fieldset className="ct-stat-group">
          <legend>Cell statistics</legend>
          {CELL_STATS.map((s) => (
            <label key={s.key} className="ct-check">
              <input
                type="checkbox"
                checked={cellStats.has(s.key)}
                onChange={() => toggle(setCellStats, s.key)}
              />
              {s.label}
            </label>
          ))}
        </fieldset>
        <fieldset className="ct-stat-group">
          <legend>Summary row</legend>
          {SUMMARY_ROW_STATS.map((s) => {
            const disabled = !numericOk && NUMERIC_SUMMARY_ROW.has(s.key)
            return (
              <label
                key={s.key}
                className="ct-check"
                title={disabled ? 'Needs a row with numeric values' : undefined}
              >
                <input
                  type="checkbox"
                  checked={summaryRows.has(s.key)}
                  disabled={disabled}
                  onChange={() => toggle(setSummaryRows, s.key)}
                />
                {s.label}
              </label>
            )
          })}
        </fieldset>
        <fieldset className="ct-stat-group">
          <legend>Summary column</legend>
          {SUMMARY_COL_STATS.map((s) => (
            <label key={s.key} className="ct-check">
              <input
                type="checkbox"
                checked={summaryCols.has(s.key)}
                onChange={() => toggle(setSummaryCols, s.key)}
              />
              {s.label}
            </label>
          ))}
        </fieldset>
      </div>

      {error && <p className="error">{error}</p>}

      {result && margins && (
        <div className="table-scroll">
          <table className="grid crosstab">
            <thead>
              <tr>
                <th />
                {result.columns.map((c) => (
                  <th key={c.label} className="ct-colhead">
                    {c.label}
                  </th>
                ))}
                {activeSummaryCols.map((s) => (
                  <th key={s.key} className="ct-colhead ct-summary-head">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.row_labels.map((label, ri) => (
                <tr key={label}>
                  <th className="ct-rowhead">{label}</th>
                  {result.cells[ri].map((cell, ci) => {
                    const lines = cellLines(
                      cell.count,
                      result.columns[ci].base,
                      margins.rowTotals[ri],
                    )
                    return (
                      <td key={result.columns[ci].label} className="ct-cell">
                        {lines.map((ln) => (
                          <span key={ln.key} className="ct-stat-line">
                            {showCellLabels && (
                              <span className="ct-stat-tag">{ln.label}</span>
                            )}
                            {ln.text}
                          </span>
                        ))}
                      </td>
                    )
                  })}
                  {activeSummaryCols.map((s) => (
                    <td key={s.key} className="ct-cell ct-summary">
                      {s.key === 'row_n' ? margins.rowTotals[ri] : ''}
                    </td>
                  ))}
                </tr>
              ))}
              {activeSummaryRows.map((s) => (
                <tr key={s.key} className="ct-summary-row">
                  <th className="ct-rowhead ct-summary">{s.label}</th>
                  {result.columns.map((c, ci) => (
                    <td key={c.label} className="ct-cell ct-summary">
                      {summaryRowValue(s.key, ci)}
                    </td>
                  ))}
                  {activeSummaryCols.map((sc) => (
                    <td key={sc.key} className="ct-cell ct-summary">
                      {summaryRowCorner(s.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!result && !error && !loading && (
        <p className="muted">Choose a row and a column variable to build a table.</p>
      )}
      </div>
    </div>
  )
}
