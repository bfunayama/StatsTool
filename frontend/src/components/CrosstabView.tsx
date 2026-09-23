import {
  useEffect,
  useMemo,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  runCrosstab,
  saveCrosstabs,
  exportXlsx,
  type BannerColumnGroup,
  type BannerSegment,
  type CrosstabColumn,
  type CrosstabGroup,
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
type SummaryRowStat = 'base_n' | 'eff_n' | 'total_count' | 'total_sum' | 'mean'
type SummaryColStat = 'row_n'
type SigStat = 'letters' | 'arrows'

const CELL_STATS: { key: CellStat; label: string }[] = [
  { key: 'count', label: 'Count' },
  { key: 'col_pct', label: 'Column %' },
  { key: 'row_pct', label: 'Row %' },
  { key: 'total_pct', label: 'Total %' },
]
const SUMMARY_ROW_STATS: { key: SummaryRowStat; label: string }[] = [
  { key: 'base_n', label: 'Base n' },
  { key: 'eff_n', label: 'Effective n' },
  { key: 'total_count', label: 'Column n' },
  { key: 'total_sum', label: 'Total Sum' },
  { key: 'mean', label: 'Mean' },
]
const SUMMARY_COL_STATS: { key: SummaryColStat; label: string }[] = [
  { key: 'row_n', label: 'Row n' },
]
const SIG_STATS: { key: SigStat; label: string }[] = [
  { key: 'arrows', label: 'Arrows (vs. rest)' },
  { key: 'letters', label: 'Column letters' },
]
// Total Sum / Mean only make sense when the row has numeric values.
const NUMERIC_SUMMARY_ROW: Set<SummaryRowStat> = new Set(['total_sum', 'mean'])

// Column value meaning "no crossing variable" — a single Total-sample banner.
const TOTAL = '__total__'
// Separator for sub-column keys: `${segmentIndex}\u0001${categoryLabel}`.
const CATSEP = '\u0001'

const Z_CRIT_95 = 1.959963985 // two-tailed critical value at 95% confidence

// Standard normal CDF (Abramowitz & Stegun 26.2.17); good to ~1e-7.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2)
  let p =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  if (z > 0) p = 1 - p
  return p
}

// Pooled two-proportion z statistic, or null when it cannot be computed.
function twoPropZ(
  p1: number,
  n1: number,
  p2: number,
  n2: number,
): number | null {
  if (n1 <= 0 || n2 <= 0) return null
  const pooled = (p1 * n1 + p2 * n2) / (n1 + n2)
  const variance = pooled * (1 - pooled) * (1 / n1 + 1 / n2)
  if (variance <= 0) return null
  return (p1 - p2) / Math.sqrt(variance)
}

// Result of a manual cell-vs-cell significance test (or an error message).
type SigTestResult =
  | { error: string }
  | {
      kind: 'proportion' | 'mean'
      labelA: string
      labelB: string
      valueA: number
      valueB: number
      nA: number
      nB: number
      z: number
      p: number
      significant: boolean
    }

function fmtPct(value: number | null): string {
  return value === null ? '' : `${value.toFixed(1)}%`
}

function fmtNumber(value: number | null): string {
  if (value === null) return ''
  return Number.isInteger(value) ? `${value}` : value.toFixed(2)
}

function fmtCount(value: number | null): string {
  return value === null ? '' : `${Math.round(value)}`
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

// Id of the folder that contains `childId` (null = top level; undefined = absent).
function findParentId(
  nodes: CrosstabNode[],
  childId: string,
  parent: string | null,
): string | null | undefined {
  for (const node of nodes) {
    if (node.id === childId) return parent
    const found = findParentId(node.children, childId, node.id)
    if (found !== undefined) return found
  }
  return undefined
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
    () => meta.variables.filter((v) => !v.question_id && v.type !== 'weight'),
    [meta.variables],
  )
  const weightVars = useMemo(
    () => meta.variables.filter((v) => v.type === 'weight'),
    [meta.variables],
  )
  const multiQuestions = useMemo(
    () => (meta.questions ?? []).filter((q) => q.kind === 'multi'),
    [meta.questions],
  )

  const [rowValue, setRowValue] = useState('')
  const [colValue, setColValue] = useState(TOTAL)
  // Advanced banner: side-by-side segments, each 1 variable or a 2-level nest.
  // Empty = simple mode (use the single Column dropdown, with column NET/hide).
  const [bannerSegments, setBannerSegments] = useState<BannerSegment[]>([])
  // Sub-column operations (advanced banner mode only), keyed by segment+category.
  const [bannerGroups, setBannerGroups] = useState<BannerColumnGroup[]>([])
  const [selCats, setSelCats] = useState<Set<string>>(new Set())
  const [catHidden, setCatHidden] = useState<Set<string>>(new Set())
  const [catRenames, setCatRenames] = useState<Record<string, string>>({})
  const [parentHidden, setParentHidden] = useState<Set<string>>(new Set())
  const [parentRenames, setParentRenames] = useState<Record<string, string>>({})
  const [advMenu, setAdvMenu] = useState<{
    x: number
    y: number
    kind: 'leaf' | 'parent'
    seg: number
    label: string
    group: string
  } | null>(null)
  const [advEdit, setAdvEdit] = useState<{ kind: 'leaf' | 'parent'; key: string } | null>(
    null,
  )
  const [advDraft, setAdvDraft] = useState('')
  const [filterId, setFilterId] = useState('')
  const [weightId, setWeightId] = useState('')
  const [result, setResult] = useState<CrosstabResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cellStats, setCellStats] = useState<Set<CellStat>>(
    () => new Set<CellStat>(['col_pct']),
  )
  const [summaryRows, setSummaryRows] = useState<Set<SummaryRowStat>>(
    () => new Set<SummaryRowStat>(['total_count']),
  )
  const [summaryCols, setSummaryCols] = useState<Set<SummaryColStat>>(
    () => new Set<SummaryColStat>(),
  )
  const [sig, setSig] = useState<Set<SigStat>>(() => new Set<SigStat>())
  // NET/merge groupings applied to the current table's rows and columns.
  const [rowGroups, setRowGroups] = useState<CrosstabGroup[]>([])
  const [columnGroups, setColumnGroups] = useState<CrosstabGroup[]>([])
  // Drag-and-drop + right-click state for building/undoing groups.
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [menu, setMenu] = useState<
    { x: number; y: number; dim: 'row' | 'col'; label: string } | null
  >(null)
  // Header multi-select (shift/cmd), inline rename, and hidden categories.
  const [selRows, setSelRows] = useState<Set<string>>(new Set())
  const [selCols, setSelCols] = useState<Set<string>>(new Set())
  // Individual cell selection (⌘/Ctrl+click) for manual pairwise sig tests.
  const [selCells, setSelCells] = useState<Set<string>>(new Set())
  const [sigTest, setSigTest] = useState<SigTestResult | null>(null)
  const [anchorRow, setAnchorRow] = useState<string | null>(null)
  const [anchorCol, setAnchorCol] = useState<string | null>(null)
  const [headerEdit, setHeaderEdit] = useState<
    { dim: 'row' | 'col'; label: string } | null
  >(null)
  const [headerDraft, setHeaderDraft] = useState('')
  const [rowRenames, setRowRenames] = useState<Record<string, string>>({})
  const [colRenames, setColRenames] = useState<Record<string, string>>({})
  const [rowHidden, setRowHidden] = useState<Set<string>>(new Set())
  const [colHidden, setColHidden] = useState<Set<string>>(new Set())

  // Saved-crosstab tree (folders + saved tables), persisted on the dataset.
  const [tree, setTree] = useState<CrosstabNode[]>(meta.crosstabs ?? [])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [treeError, setTreeError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<CrosstabNode | null>(null)
  // Multi-select of saved tables for export, plus export progress/error.
  const [exportSel, setExportSel] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(
    () => Number(localStorage.getItem('statstool.ctSidebar')) || 240,
  )

  // Advanced banner active → send segments and disable per-column NET/hide/rename.
  const advancedBanner = bannerSegments.length > 0
  const bannerKey = JSON.stringify(bannerSegments)
  const bannerGroupsKey = JSON.stringify(bannerGroups)
  const hasColumn = advancedBanner || !!colValue

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
    if (!row || !hasColumn) return null
    return {
      row,
      column: advancedBanner ? null : colValue === TOTAL ? null : colValue,
      banner: bannerSegments,
      filter_id: filterId || null,
      weight: weightId || null,
      display: {
        cell_stats: CELL_STATS.filter((s) => cellStats.has(s.key)).map((s) => s.key),
        summary_rows: SUMMARY_ROW_STATS.filter((s) => summaryRows.has(s.key)).map(
          (s) => s.key,
        ),
        summary_cols: SUMMARY_COL_STATS.filter((s) => summaryCols.has(s.key)).map(
          (s) => s.key,
        ),
        significance: SIG_STATS.filter((s) => sig.has(s.key)).map((s) => s.key),
      },
      row_groups: rowGroups,
      column_groups: columnGroups,
      banner_groups: bannerGroups,
      row_renames: rowRenames,
      column_renames: colRenames,
      row_hidden: [...rowHidden],
      column_hidden: [...colHidden],
      banner_cat_renames: catRenames,
      banner_cat_hidden: [...catHidden],
      banner_parent_renames: parentRenames,
      banner_parent_hidden: [...parentHidden],
    }
  }

  function loadSpec(spec: SavedCrosstabSpec) {
    setRowValue(encodeRow(spec.row))
    setColValue(spec.column ?? TOTAL)
    setBannerSegments(spec.banner ?? [])
    setBannerGroups(spec.banner_groups ?? [])
    setFilterId(spec.filter_id ?? '')
    setWeightId(spec.weight ?? '')
    setCellStats(new Set(spec.display.cell_stats as CellStat[]))
    setSummaryRows(new Set(spec.display.summary_rows as SummaryRowStat[]))
    setSummaryCols(new Set(spec.display.summary_cols as SummaryColStat[]))
    setSig(new Set((spec.display.significance ?? []) as SigStat[]))
    setRowGroups(spec.row_groups ?? [])
    setColumnGroups(spec.column_groups ?? [])
    setRowRenames(spec.row_renames ?? {})
    setColRenames(spec.column_renames ?? {})
    setRowHidden(new Set(spec.row_hidden ?? []))
    setColHidden(new Set(spec.column_hidden ?? []))
    setCatRenames(spec.banner_cat_renames ?? {})
    setCatHidden(new Set(spec.banner_cat_hidden ?? []))
    setParentRenames(spec.banner_parent_renames ?? {})
    setParentHidden(new Set(spec.banner_parent_hidden ?? []))
    setSelCats(new Set())
    setSelRows(new Set())
    setSelCols(new Set())
    setAnchorRow(null)
    setAnchorCol(null)
    setHeaderEdit(null)
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
    // New tables should save alongside the one you opened.
    setActiveFolderId(findParentId(tree, node.id, null) ?? null)
  }

  function closeTable() {
    setSelectedId(null)
    setTitleDraft('')
  }

  // Blank builder with the default selections (used by the "+ Table" button).
  function newCrosstab() {
    setSelectedId(null)
    setTitleDraft('')
    setRowValue('')
    setColValue(TOTAL)
    setBannerSegments([])
    setBannerGroups([])
    setFilterId('')
    setWeightId('')
    setCellStats(new Set<CellStat>(['col_pct']))
    setSummaryRows(new Set<SummaryRowStat>(['total_count']))
    setSummaryCols(new Set<SummaryColStat>())
    setSig(new Set<SigStat>())
    setRowGroups([])
    setColumnGroups([])
    setRowRenames({})
    setColRenames({})
    setRowHidden(new Set())
    setColHidden(new Set())
    setCatHidden(new Set())
    setCatRenames({})
    setParentHidden(new Set())
    setParentRenames({})
    setSelCats(new Set())
    setSelRows(new Set())
    setSelCols(new Set())
    setSelCells(new Set())
    setAnchorRow(null)
    setAnchorCol(null)
    setHeaderEdit(null)
  }

  // After saving, carry the analysis config (row, column, weight, filter, stats,
  // significance) into a fresh unsaved table; only the saved-table link, title,
  // and table-specific groups/renames/hides are cleared.
  function carryOverToNewTable() {
    setSelectedId(null)
    setTitleDraft('')
    setRowGroups([])
    setColumnGroups([])
    setBannerGroups([])
    setRowRenames({})
    setColRenames({})
    setRowHidden(new Set())
    setColHidden(new Set())
    setCatHidden(new Set())
    setCatRenames({})
    setParentHidden(new Set())
    setParentRenames({})
    setSelCats(new Set())
    setSelRows(new Set())
    setSelCols(new Set())
    setSelCells(new Set())
    setAnchorRow(null)
    setAnchorCol(null)
    setHeaderEdit(null)
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
    const auto =
      colValue && colValue !== TOTAL
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
    // Move on to a fresh crosstab; the saved one now lives in the tree.
    carryOverToNewTable()
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
    // Move on to a fresh crosstab after saving, like "Save as table".
    carryOverToNewTable()
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
    setConfirmDelete(node)
  }

  function confirmDeleteNode() {
    const node = confirmDelete
    if (!node) return
    persistTree(removeNode(tree, node.id))
    if (selectedId && findNode([node], selectedId)) setSelectedId(null)
    setConfirmDelete(null)
  }

  // All saved crosstab nodes (flattened) that carry a spec.
  function collectCrosstabNodes(nodes: CrosstabNode[]): CrosstabNode[] {
    const out: CrosstabNode[] = []
    for (const node of nodes) {
      if (node.kind === 'crosstab' && node.spec) out.push(node)
      out.push(...collectCrosstabNodes(node.children))
    }
    return out
  }

  async function doExport(tables: { name: string; spec: SavedCrosstabSpec }[]) {
    if (tables.length === 0) {
      setTreeError('No tables to export.')
      return
    }
    setExporting(true)
    setTreeError(null)
    try {
      await exportXlsx(meta.id, tables)
    } catch (err) {
      setTreeError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  function exportAll() {
    doExport(
      collectCrosstabNodes(tree).map((n) => ({ name: n.name, spec: n.spec! })),
    )
  }

  function exportSelected() {
    doExport(
      collectCrosstabNodes(tree)
        .filter((n) => exportSel.has(n.id))
        .map((n) => ({ name: n.name, spec: n.spec! })),
    )
  }

  function exportCurrent() {
    const spec = currentSpec()
    if (!spec) return
    const name =
      titleDraft.trim() || (rowValue ? rowLabelFor(rowValue) : 'Table')
    doExport([{ name, spec }])
  }

  function toggleExportSel(id: string) {
    setExportSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
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
    if (!row || !hasColumn) {
      setResult(null)
      setError(null)
      return
    }
    let ignore = false
    setLoading(true)
    setError(null)
    runCrosstab(meta.id, {
      row,
      column: advancedBanner ? null : colValue === TOTAL ? null : colValue,
      banner: advancedBanner ? bannerSegments : [],
      bannerGroups: advancedBanner ? bannerGroups : [],
      filterId: filterId || null,
      weight: weightId || null,
      rowGroups,
      columnGroups: advancedBanner ? [] : columnGroups,
    })
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
  }, [meta.id, rowValue, colValue, bannerKey, bannerGroupsKey, filterId, weightId, rowGroups, columnGroups])

  // A new/rebuilt table invalidates any cell selection (indices shift).
  useEffect(() => {
    setSelCells(new Set())
  }, [result])
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

  // ⌘/Ctrl+click a cell (category or Mean) to add/remove it from the test pair.
  function toggleSel(key: string) {
    setSelCells((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Per-column mean, sample variance, and (effective) n from the frequency table.
  function columnMeanStats(
    ci: number,
  ): { mean: number; variance: number; n: number } | null {
    if (!result) return null
    let sw = 0
    let swx = 0
    let swx2 = 0
    for (let ri = 0; ri < result.row_values.length; ri++) {
      const v = result.row_values[ri]
      if (v == null) continue
      const f = result.cells[ri][ci].count
      sw += f
      swx += f * v
      swx2 += f * v * v
    }
    if (sw <= 0) return null
    const mean = swx / sw
    const popVar = Math.max(0, swx2 / sw - mean * mean)
    const col = result.columns[ci]
    const n = result.weighted
      ? col.base
        ? (col.eff_base ?? col.base) * (sw / col.base)
        : 0
      : sw
    if (n <= 1) return null
    return { mean, variance: (popVar * n) / (n - 1), n }
  }

  const netOverlap = (ci: number) =>
    !!result &&
    columnGroups.some(
      (g) => g.mode === 'net' && g.label === result.columns[ci].label,
    )

  // Compare the two selected cells; two %s → proportion test, two Means → mean
  // test. Result (or an error) is shown in a popup.
  function runCellSigTest() {
    if (!result || selCells.size !== 2) return
    const [ka, kb] = [...selCells]
    const fail = (error: string) => setSigTest({ error })
    const isMean = (k: string) => k.startsWith('mean:')

    if (isMean(ka) !== isMean(kb)) {
      fail(
        'A significance test could not be conducted — select two cells of the same kind (two percentages, or two Means).',
      )
      return
    }

    if (isMean(ka)) {
      const ca = Number(ka.slice(5))
      const cb = Number(kb.slice(5))
      if (netOverlap(ca) || netOverlap(cb)) {
        fail(
          'A significance test could not be conducted between these cells — NET columns overlap other columns, so the samples are not independent.',
        )
        return
      }
      const a = columnMeanStats(ca)
      const b = columnMeanStats(cb)
      if (!a || !b) {
        fail('A significance test could not be conducted between these means.')
        return
      }
      const se = Math.sqrt(a.variance / a.n + b.variance / b.n)
      if (!(se > 0)) {
        fail('A significance test could not be conducted between these means.')
        return
      }
      const z = (a.mean - b.mean) / se
      setSigTest({
        kind: 'mean',
        labelA: `Mean · ${dispCol(result.columns[ca].label)}`,
        labelB: `Mean · ${dispCol(result.columns[cb].label)}`,
        valueA: a.mean,
        valueB: b.mean,
        nA: a.n,
        nB: b.n,
        z,
        p: 2 * (1 - normalCdf(Math.abs(z))),
        significant: Math.abs(z) >= Z_CRIT_95,
      })
      return
    }

    const [ra, ca] = ka.split(':').map(Number)
    const [rb, cb] = kb.split(':').map(Number)
    if (ca === cb) {
      fail(
        'A significance test could not be conducted between these cells — they are in the same column, so their bases are not independent.',
      )
      return
    }
    if (netOverlap(ca) || netOverlap(cb)) {
      fail(
        'A significance test could not be conducted between these cells — NET columns overlap other columns, so the samples are not independent.',
      )
      return
    }
    const cellA = result.cells[ra][ca]
    const cellB = result.cells[rb][cb]
    const colA = result.columns[ca]
    const colB = result.columns[cb]
    if (cellA.column_pct == null || cellB.column_pct == null) {
      fail('A significance test could not be conducted between these cells.')
      return
    }
    const nA = result.weighted ? colA.eff_base ?? colA.base : colA.base
    const nB = result.weighted ? colB.eff_base ?? colB.base : colB.base
    const z = twoPropZ(cellA.column_pct / 100, nA, cellB.column_pct / 100, nB)
    if (z == null) {
      fail('A significance test could not be conducted between these cells.')
      return
    }
    setSigTest({
      kind: 'proportion',
      labelA: `${dispRow(result.row_labels[ra])} · ${dispCol(colA.label)}`,
      labelB: `${dispRow(result.row_labels[rb])} · ${dispCol(colB.label)}`,
      valueA: cellA.column_pct,
      valueB: cellB.column_pct,
      nA,
      nB,
      z,
      p: 2 * (1 - normalCdf(Math.abs(z))),
      significant: Math.abs(z) >= Z_CRIT_95,
    })
  }

  // Ordered list of cell-stat lines to render inside one cell.
  function cellLines(count: number, colBase: number, rowTotal: number) {
    const lines: { key: CellStat; label: string; text: string }[] = []
    for (const stat of CELL_STATS) {
      if (!cellStats.has(stat.key)) continue
      let text = ''
      if (stat.key === 'count') text = fmtCount(count)
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
    if (key === 'base_n') return fmtCount(result.columns[ci].base)
    if (key === 'eff_n') {
      const eff = result.columns[ci].eff_base
      return fmtCount(eff ?? result.columns[ci].base)
    }
    if (key === 'total_count') return fmtCount(margins.colTotals[ci])
    if (key === 'total_sum') return fmtNumber(margins.colSums[ci])
    const valid = margins.colValidCounts[ci]
    return fmtNumber(valid ? margins.colSums[ci] / valid : null)
  }

  // Overall value of a summary-row statistic (shown in the summary column).
  function summaryRowCorner(key: SummaryRowStat): string {
    if (!margins || !result) return ''
    if (key === 'base_n') return fmtCount(result.total_base)
    if (key === 'eff_n') return fmtCount(result.total_eff_base ?? result.total_base)
    if (key === 'total_count') return fmtCount(margins.grandCount)
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
  const cellStatLabels = CELL_STATS.filter((s) => cellStats.has(s.key)).map(
    (s) => s.label,
  )
  const lettersOn = sig.has('letters')
  const arrowsOn = sig.has('arrows')
  const sigOn = (lettersOn || arrowsOn) && !!result && result.columns.length >= 2
  const rowGroupLabels = new Set(rowGroups.map((g) => g.label))
  const colGroupLabels = new Set(columnGroups.map((g) => g.label))
  // Display order of base categories, used to keep group labels readable.
  const rowOrder = new Map<string, number>()
  const colOrder = new Map<string, number>()
  if (result) {
    let i = 0
    for (const l of result.row_labels)
      if (!rowGroupLabels.has(l)) rowOrder.set(l, i++)
    let j = 0
    for (const c of result.columns)
      if (!colGroupLabels.has(c.label)) colOrder.set(c.label, j++)
  }
  // Visible (not hidden) row/column indices into the result.
  const visColIdx = result
    ? result.columns
        .map((_c, i) => i)
        .filter((i) => {
          const c = result.columns[i]
          if (advancedBanner)
            return !catHidden.has(catKey(c)) && !parentHidden.has(c.group ?? '')
          return !colHidden.has(c.label)
        })
    : []
  const visRowIdx = result
    ? result.row_labels
        .map((_l, i) => i)
        .filter((i) => !rowHidden.has(result.row_labels[i]))
    : []
  const hiddenRowList = result
    ? result.row_labels.filter((l) => rowHidden.has(l))
    : []
  const hiddenColList = result
    ? result.columns.map((c) => c.label).filter((l) => colHidden.has(l))
    : []
  // Hidden sub-columns / parents (advanced banner mode).
  const hiddenCatList = [...catHidden].map((k) => ({
    key: k,
    label: k.split(CATSEP).slice(1).join(CATSEP),
  }))
  const hiddenParentList = result
    ? [...parentHidden].map((g) => ({
        group: g,
        label: result.columns.find((c) => (c.group ?? '') === g)?.top_label ?? g,
      }))
    : []

  // Two-level banner → render a spanning top header row. Top spans group
  // contiguous visible columns that share a banner sub-group.
  const twoLevel = !!result && result.columns.some((c) => c.top_label)
  const topSpans: { key: string; label: string; count: number; group: string }[] = []
  if (result && twoLevel) {
    for (const ci of visColIdx) {
      const c = result.columns[ci]
      const gid = c.group ?? ''
      const last = topSpans[topSpans.length - 1]
      if (last && last.key === gid) last.count += 1
      else topSpans.push({ key: gid, label: dispTop(c), count: 1, group: gid })
    }
  }

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

  // Swap the row and column. Only works when the row is a plain variable,
  // because a grouped (Pick any) variable cannot sit in the column banner.
  const canSwap = (() => {
    const row = decodeRow(rowValue)
    return (
      !advancedBanner &&
      !!colValue &&
      colValue !== TOTAL &&
      !!row &&
      row.kind === 'variable'
    )
  })()

  function swapRowColumn() {
    const row = decodeRow(rowValue)
    if (!row || row.kind !== 'variable' || !colValue) return
    setRowValue(`v:${colValue}`)
    setColValue(row.ref)
    // The variables trade places, so their groupings follow.
    setRowGroups(columnGroups)
    setColumnGroups(rowGroups)
    setRowRenames(colRenames)
    setColRenames(rowRenames)
    setRowHidden(colHidden)
    setColHidden(rowHidden)
    setSelRows(new Set())
    setSelCols(new Set())
  }

  // Changing a variable invalidates that dimension's groupings.
  function changeRow(value: string) {
    setRowValue(value)
    setRowGroups([])
    setRowRenames({})
    setRowHidden(new Set())
    setSelRows(new Set())
    setAnchorRow(null)
  }

  function changeColumn(value: string) {
    setColValue(value)
    setColumnGroups([])
    setColRenames({})
    setColHidden(new Set())
    setSelCols(new Set())
    setAnchorCol(null)
  }

  // Set a banner segment's primary (level 0) or nested (level 1) variable.
  function setSegmentVar(si: number, level: 0 | 1, value: string) {
    setBannerSegments((prev) =>
      prev.map((seg, i) => {
        if (i !== si) return seg
        if (level === 0) {
          if (!value) return { variables: [] }
          const nested = seg.variables[1]
          return {
            variables: nested && nested !== value ? [value, nested] : [value],
          }
        }
        const primary = seg.variables[0]
        if (!primary) return seg
        return { variables: value ? [primary, value] : [primary] }
      }),
    )
  }

  function removeSegment(si: number) {
    setBannerSegments((prev) => prev.filter((_, i) => i !== si))
  }

  // --- Sub-column (advanced banner) helpers, keyed by segment + category ---
  function catKey(c: CrosstabColumn) {
    return `${c.seg ?? -1}${CATSEP}${c.label}`
  }
  function dispLeaf(c: CrosstabColumn) {
    return catRenames[catKey(c)] ?? c.label
  }
  function dispTop(c: CrosstabColumn) {
    return parentRenames[c.group ?? ''] ?? c.top_label ?? ''
  }
  function bannerGroupOf(c: CrosstabColumn) {
    return bannerGroups.find((g) => g.seg === (c.seg ?? -1) && g.label === c.label)
  }

  function toggleCat(key: string, additive: boolean) {
    setSelCats((prev) => {
      const next = additive ? new Set(prev) : new Set<string>()
      if (prev.has(key) && additive) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function uniqueBannerLabel(base: string, seg: number): string {
    const labels = new Set(
      bannerGroups.filter((g) => g.seg === seg).map((g) => g.label),
    )
    if (!labels.has(base)) return base
    let n = 2
    while (labels.has(`${base} ${n}`)) n += 1
    return `${base} ${n}`
  }

  // Merge or NET the selected leaf categories (must all be in one segment).
  function makeBannerGroup(mode: 'net' | 'merge') {
    const keys = [...selCats]
    if (keys.length < 2) return
    const segs = new Set(keys.map((k) => Number(k.split(CATSEP)[0])))
    if (segs.size !== 1) return
    const seg = [...segs][0]
    const members = keys.map((k) => k.split(CATSEP).slice(1).join(CATSEP))
    const label = uniqueBannerLabel(
      mode === 'net' ? 'NET' : members.join(' / '),
      seg,
    )
    setBannerGroups([
      ...bannerGroups,
      { id: crypto.randomUUID(), seg, label, members, mode },
    ])
    setSelCats(new Set())
  }

  function ungroupBanner(seg: number, label: string) {
    setBannerGroups((prev) =>
      prev.filter((g) => !(g.seg === seg && g.label === label)),
    )
  }

  function toggleBannerMode(seg: number, label: string) {
    setBannerGroups((prev) =>
      prev.map((g) => {
        if (g.seg !== seg || g.label !== label) return g
        const mode = g.mode === 'net' ? 'merge' : 'net'
        return { ...g, mode, label: mode === 'net' ? 'NET' : g.members.join(' / ') }
      }),
    )
  }

  function hideCat(key: string) {
    setCatHidden((prev) => new Set(prev).add(key))
  }
  function hideParent(group: string) {
    setParentHidden((prev) => new Set(prev).add(group))
  }
  function unhideCat(key: string) {
    setCatHidden((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }
  function unhideParent(group: string) {
    setParentHidden((prev) => {
      const next = new Set(prev)
      next.delete(group)
      return next
    })
  }

  function startAdvEdit(kind: 'leaf' | 'parent', key: string, current: string) {
    setAdvEdit({ kind, key })
    setAdvDraft(current)
  }
  function commitAdvEdit() {
    if (!advEdit) return
    const draft = advDraft.trim()
    const setter = advEdit.kind === 'leaf' ? setCatRenames : setParentRenames
    setter((prev) => {
      const next = { ...prev }
      if (!draft) delete next[advEdit.key]
      else next[advEdit.key] = draft
      return next
    })
    setAdvEdit(null)
  }

  function uniqueGroupLabel(base: string, existing: CrosstabGroup[]): string {
    const labels = new Set(existing.map((g) => g.label))
    if (!labels.has(base)) return base
    let n = 2
    while (labels.has(`${base} ${n}`)) n += 1
    return `${base} ${n}`
  }

  function autoLabel(
    members: string[],
    mode: 'net' | 'merge',
    order: Map<string, number>,
  ): string {
    if (mode === 'net') return 'NET'
    return [...members]
      .sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9))
      .join(' / ')
  }

  // Add a category to a group, refreshing an auto-generated (not renamed) label.
  function withMember(
    g: CrosstabGroup,
    member: string,
    order: Map<string, number>,
  ): CrosstabGroup {
    if (g.members.includes(member)) return g
    const members = [...g.members, member]
    const wasAuto = g.label === autoLabel(g.members, g.mode, order)
    return { ...g, members, label: wasAuto ? autoLabel(members, g.mode, order) : g.label }
  }

  // Drop the dragged header `source` onto `target` within one dimension.
  function applyDrop(dim: 'row' | 'col', source: string, target: string) {
    if (source === target) return
    const groups = dim === 'row' ? rowGroups : columnGroups
    const setGroups = dim === 'row' ? setRowGroups : setColumnGroups
    const order = dim === 'row' ? rowOrder : colOrder
    // Dragging a member of a multi-selection merges the whole selection.
    const sel = dim === 'row' ? selRows : selCols
    if (sel.size >= 2 && sel.has(source)) {
      const tg = groups.find((g) => g.label === target)
      if (tg) {
        let next = tg
        for (const m of sel) next = withMember(next, m, order)
        setGroups(groups.map((g) => (g.id === tg.id ? next : g)))
      } else {
        createGroupFromMembers(dim, [...sel, target], 'merge')
      }
      clearSel(dim)
      return
    }
    const sg = groups.find((g) => g.label === source)
    const tg = groups.find((g) => g.label === target)
    if (!sg && !tg) {
      const members = [source, target].sort(
        (a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9),
      )
      const label = uniqueGroupLabel(autoLabel(members, 'merge', order), groups)
      setGroups([
        ...groups,
        { id: crypto.randomUUID(), label, members, mode: 'merge' },
      ])
    } else if (sg && !tg) {
      setGroups(groups.map((g) => (g.id === sg.id ? withMember(g, target, order) : g)))
    } else if (!sg && tg) {
      setGroups(groups.map((g) => (g.id === tg.id ? withMember(g, source, order) : g)))
    } else if (sg && tg && sg.id !== tg.id) {
      const members = Array.from(new Set([...sg.members, ...tg.members]))
      const wasAuto = sg.label === autoLabel(sg.members, sg.mode, order)
      setGroups(
        groups
          .filter((g) => g.id !== tg.id)
          .map((g) =>
            g.id === sg.id
              ? {
                  ...g,
                  members,
                  label: wasAuto ? autoLabel(members, g.mode, order) : g.label,
                }
              : g,
          ),
      )
    }
  }

  function startDrag(e: ReactDragEvent, dim: 'row' | 'col', label: string) {
    e.dataTransfer.setData('text/plain', JSON.stringify({ dim, label }))
    e.dataTransfer.effectAllowed = 'move'
  }

  function onDropHeader(e: ReactDragEvent, dim: 'row' | 'col', target: string) {
    e.preventDefault()
    setDropTarget(null)
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'))
      if (data && data.dim === dim) applyDrop(dim, data.label, target)
    } catch {
      // ignore malformed drops
    }
  }

  function ungroup(dim: 'row' | 'col', label: string) {
    if (dim === 'row') setRowGroups(rowGroups.filter((g) => g.label !== label))
    else setColumnGroups(columnGroups.filter((g) => g.label !== label))
  }

  function toggleGroupMode(dim: 'row' | 'col', label: string) {
    const order = dim === 'row' ? rowOrder : colOrder
    const flip = (g: CrosstabGroup): CrosstabGroup => {
      if (g.label !== label) return g
      const mode = g.mode === 'net' ? 'merge' : 'net'
      const wasAuto = g.label === autoLabel(g.members, g.mode, order)
      return { ...g, mode, label: wasAuto ? autoLabel(g.members, mode, order) : g.label }
    }
    if (dim === 'row') setRowGroups(rowGroups.map(flip))
    else setColumnGroups(columnGroups.map(flip))
  }

  function dispRow(l: string): string {
    return rowRenames[l] ?? l
  }
  function dispCol(l: string): string {
    return colRenames[l] ?? l
  }

  // Header click selection: shift = range from anchor, cmd/ctrl = toggle.
  function selectHeader(
    dim: 'row' | 'col',
    label: string,
    e: ReactMouseEvent,
  ) {
    const sel = dim === 'row' ? selRows : selCols
    const setSel = dim === 'row' ? setSelRows : setSelCols
    const anchor = dim === 'row' ? anchorRow : anchorCol
    const setAnchor = dim === 'row' ? setAnchorRow : setAnchorCol
    const order = dim === 'row' ? rowOrder : colOrder
    if (e.shiftKey && anchor && order.has(anchor) && order.has(label)) {
      const a = order.get(anchor) as number
      const b = order.get(label) as number
      const [lo, hi] = a < b ? [a, b] : [b, a]
      const next = new Set(sel)
      for (const [l, i] of order) if (i >= lo && i <= hi) next.add(l)
      setSel(next)
    } else if (e.metaKey || e.ctrlKey) {
      const next = new Set(sel)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      setSel(next)
      setAnchor(label)
    } else {
      setSel(new Set([label]))
      setAnchor(label)
    }
  }

  function clearSel(dim: 'row' | 'col') {
    if (dim === 'row') {
      setSelRows(new Set())
      setAnchorRow(null)
    } else {
      setSelCols(new Set())
      setAnchorCol(null)
    }
  }

  function createGroupFromMembers(
    dim: 'row' | 'col',
    members: string[],
    mode: 'net' | 'merge',
  ) {
    if (members.length < 2) return
    const groups = dim === 'row' ? rowGroups : columnGroups
    const setGroups = dim === 'row' ? setRowGroups : setColumnGroups
    const order = dim === 'row' ? rowOrder : colOrder
    const ordered = [...new Set(members)].sort(
      (a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9),
    )
    const label = uniqueGroupLabel(autoLabel(ordered, mode, order), groups)
    setGroups([...groups, { id: crypto.randomUUID(), label, members: ordered, mode }])
    clearSel(dim)
  }

  function mergeSelected(dim: 'row' | 'col') {
    createGroupFromMembers(dim, [...(dim === 'row' ? selRows : selCols)], 'merge')
  }

  function netSelected(dim: 'row' | 'col') {
    createGroupFromMembers(dim, [...(dim === 'row' ? selRows : selCols)], 'net')
  }

  function startHeaderEdit(dim: 'row' | 'col', label: string) {
    setHeaderEdit({ dim, label })
    setHeaderDraft(dim === 'row' ? dispRow(label) : dispCol(label))
  }

  function commitHeaderEdit() {
    if (!headerEdit) return
    const { dim, label } = headerEdit
    const draft = headerDraft.trim()
    const isGroup = (dim === 'row' ? rowGroupLabels : colGroupLabels).has(label)
    if (isGroup) {
      const groups = dim === 'row' ? rowGroups : columnGroups
      const setGroups = dim === 'row' ? setRowGroups : setColumnGroups
      setGroups(
        groups.map((g) => (g.label === label ? { ...g, label: draft || g.label } : g)),
      )
    } else {
      const ren = dim === 'row' ? rowRenames : colRenames
      const setRen = dim === 'row' ? setRowRenames : setColRenames
      const next = { ...ren }
      if (!draft || draft === label) delete next[label]
      else next[label] = draft
      setRen(next)
    }
    setHeaderEdit(null)
  }

  function hideItem(dim: 'row' | 'col', label: string) {
    if (dim === 'row') setRowHidden(new Set([...rowHidden, label]))
    else setColHidden(new Set([...colHidden, label]))
  }

  function unhide(dim: 'row' | 'col', label: string) {
    if (dim === 'row') {
      const next = new Set(rowHidden)
      next.delete(label)
      setRowHidden(next)
    } else {
      const next = new Set(colHidden)
      next.delete(label)
      setColHidden(next)
    }
  }

  function removeRowGroup(id: string) {
    setRowGroups(rowGroups.filter((g) => g.id !== id))
  }

  function removeColGroup(id: string) {
    setColumnGroups(columnGroups.filter((g) => g.id !== id))
  }

  function renameRowGroup(id: string, label: string) {
    setRowGroups(rowGroups.map((g) => (g.id === id ? { ...g, label } : g)))
  }

  function renameColGroup(id: string, label: string) {
    setColumnGroups(columnGroups.map((g) => (g.id === id ? { ...g, label } : g)))
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
            <input
              type="checkbox"
              className="ct-node-check"
              checked={exportSel.has(node.id)}
              onChange={() => toggleExportSel(node.id)}
              title="Tick to include in Export selected"
            />
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
          <button
            onClick={newCrosstab}
            title="Start a new blank crosstab with default selections"
          >
            + Table
          </button>
          <button onClick={newFolder} title="New folder">
            + Folder
          </button>
        </div>
        <div className="ct-tree-export">
          <button
            onClick={exportAll}
            disabled={exporting || collectCrosstabNodes(tree).length === 0}
            title="Export every saved table to one Excel workbook"
          >
            Export all
          </button>
          <button
            onClick={exportSelected}
            disabled={exporting || exportSel.size === 0}
            title="Export the ticked tables to one Excel workbook"
          >
            Export selected{exportSel.size > 0 ? ` (${exportSel.size})` : ''}
          </button>
          {exporting && <span className="muted">Exporting…</span>}
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
          {weightId && (
            <span className="badge ct-weighted" title="This table is weighted">
              Weighted: {weightVars.find((w) => w.name === weightId)?.label ?? weightId}
            </span>
          )}
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
          <button
            disabled={!builderSpec || exporting}
            onClick={exportCurrent}
            title="Export this table to Excel"
          >
            Export
          </button>
          <span className="spacer" />
          {loading && <span className="muted">Computing…</span>}
        </div>

        <div className="ct-controls">
        <label className="field">
          Row
          <select value={rowValue} onChange={(e) => changeRow(e.target.value)}>
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
          <select
            value={colValue}
            onChange={(e) => changeColumn(e.target.value)}
            disabled={advancedBanner}
            title={
              advancedBanner
                ? 'Using the banner builder below. Clear it to use a single column.'
                : undefined
            }
          >
            <option value="">Choose a variable…</option>
            <option value={TOTAL}>Total sample (no column)</option>
            {memberless.map((v) => (
              <option key={v.name} value={v.name}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="ct-swap"
          onClick={swapRowColumn}
          disabled={!canSwap}
          title={
            canSwap
              ? 'Switch rows and columns'
              : 'Switching needs a plain variable in the row (grouped variables can’t be a column)'
          }
        >
          ⇅ Switch Rows &amp; Columns
        </button>
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
        <label className="field">
          Weight
          <select value={weightId} onChange={(e) => setWeightId(e.target.value)}>
            <option value="">Unweighted</option>
            {weightVars.map((w) => (
              <option key={w.name} value={w.name}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        {loading && <span className="muted">Computing…</span>}
      </div>

      <div className="ct-banner">
        <span className="ct-banner-label">
          Banner
          <span className="muted"> (side-by-side / nested columns)</span>
        </span>
        {bannerSegments.length === 0 ? (
          <button
            onClick={() => {
              changeColumn('')
              setBannerSegments([{ variables: [] }])
            }}
          >
            + Build banner
          </button>
        ) : (
          <>
            {bannerSegments.map((seg, si) => (
              <span key={si} className="ct-banner-seg">
                <select
                  value={seg.variables[0] ?? ''}
                  onChange={(e) => setSegmentVar(si, 0, e.target.value)}
                  title="Banner column variable"
                >
                  <option value="">Total sample</option>
                  {memberless.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.label}
                    </option>
                  ))}
                </select>
                {seg.variables.length >= 1 && (
                  <select
                    value={seg.variables[1] ?? ''}
                    onChange={(e) => setSegmentVar(si, 1, e.target.value)}
                    title="Nest a second variable under each category"
                  >
                    <option value="">— no nesting —</option>
                    {memberless
                      .filter((v) => v.name !== seg.variables[0])
                      .map((v) => (
                        <option key={v.name} value={v.name}>
                          ↳ {v.label}
                        </option>
                      ))}
                  </select>
                )}
                <button
                  className="ct-banner-del"
                  onClick={() => removeSegment(si)}
                  title="Remove this banner column"
                >
                  ✕
                </button>
              </span>
            ))}
            <button
              onClick={() => setBannerSegments([...bannerSegments, { variables: [] }])}
            >
              + Add column
            </button>
            <button
              className="ct-banner-clear"
              onClick={() => {
                setBannerSegments([])
                setBannerGroups([])
                setSelCats(new Set())
                setCatHidden(new Set())
                setCatRenames({})
                setParentHidden(new Set())
                setParentRenames({})
              }}
            >
              Use single column
            </button>
          </>
        )}
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
        <fieldset className="ct-stat-group">
          <legend>Significance (95%)</legend>
          {SIG_STATS.map((s) => {
            const disabled = colValue === TOTAL
            return (
              <label
                key={s.key}
                className="ct-check"
                title={
                  disabled ? 'Needs a column variable (two or more columns)' : undefined
                }
              >
                <input
                  type="checkbox"
                  checked={sig.has(s.key)}
                  disabled={disabled}
                  onChange={() => toggle(setSig, s.key)}
                />
                {s.label}
              </label>
            )
          })}
        </fieldset>
      </div>

      {error && <p className="error">{error}</p>}

      {result && margins && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Click headers (Shift or ⌘/Ctrl for multiple) then Merge or NET, or drag
            one header onto another. Double-click a header to rename; right-click to
            hide, ungroup, or switch NET/merge. ⌘/Ctrl+click two cells to run a
            significance test between them (two percentages, or two Mean cells).
          </p>
          {(selRows.size >= 2 || selCols.size >= 2) && (
            <div className="ct-select-bar">
              {selRows.size >= 2 && (
                <span className="ct-select-group">
                  <span className="muted">{selRows.size} rows selected</span>
                  <button onClick={() => mergeSelected('row')}>Merge</button>
                  <button onClick={() => netSelected('row')}>NET</button>
                  <button onClick={() => clearSel('row')}>Clear</button>
                </span>
              )}
              {selCols.size >= 2 && (
                <span className="ct-select-group">
                  <span className="muted">{selCols.size} columns selected</span>
                  <button onClick={() => mergeSelected('col')}>Merge</button>
                  <button onClick={() => netSelected('col')}>NET</button>
                  <button onClick={() => clearSel('col')}>Clear</button>
                </span>
              )}
            </div>
          )}

          {selCells.size > 0 && (
            <div className="ct-select-bar">
              <span className="ct-select-group">
                <span className="muted">
                  {selCells.size} cell{selCells.size === 1 ? '' : 's'} selected
                  {selCells.size !== 2 ? ' (pick exactly 2)' : ''}
                </span>
                <button
                  disabled={selCells.size !== 2}
                  onClick={runCellSigTest}
                >
                  Sig test
                </button>
                <button onClick={() => setSelCells(new Set())}>Clear</button>
              </span>
            </div>
          )}

          {advancedBanner && selCats.size > 0 && (
            <div className="ct-select-bar">
              <span className="ct-select-group">
                <span className="muted">
                  {selCats.size} sub-column{selCats.size === 1 ? '' : 's'} selected
                </span>
                <button
                  disabled={selCats.size < 2}
                  onClick={() => makeBannerGroup('merge')}
                >
                  Merge
                </button>
                <button
                  disabled={selCats.size < 2}
                  onClick={() => makeBannerGroup('net')}
                >
                  NET
                </button>
                <button onClick={() => setSelCats(new Set())}>Clear</button>
              </span>
            </div>
          )}

          <div className="table-scroll">
          <table className="grid crosstab">
            <thead>
              {twoLevel ? (
                <>
                  <tr>
                    <th className="ct-corner" rowSpan={2}>
                      {cellStatLabels.map((label) => (
                        <span key={label} className="ct-legend-line">
                          {label}
                        </span>
                      ))}
                    </th>
                    {topSpans.map((span) => {
                      const editing =
                        advEdit?.kind === 'parent' && advEdit.key === span.group
                      return (
                        <th
                          key={span.key}
                          className="ct-colhead ct-top-head"
                          colSpan={span.count}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setAdvMenu({
                              x: e.clientX,
                              y: e.clientY,
                              kind: 'parent',
                              seg: -1,
                              label: span.label,
                              group: span.group,
                            })
                          }}
                        >
                          {editing ? (
                            <input
                              className="cell-input ct-head-input"
                              autoFocus
                              value={advDraft}
                              onChange={(e) => setAdvDraft(e.target.value)}
                              onBlur={commitAdvEdit}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitAdvEdit()
                                else if (e.key === 'Escape') setAdvEdit(null)
                              }}
                            />
                          ) : (
                            <span
                              onDoubleClick={() =>
                                startAdvEdit('parent', span.group, span.label)
                              }
                            >
                              {span.label}
                            </span>
                          )}
                        </th>
                      )
                    })}
                    {activeSummaryCols.map((s) => (
                      <th
                        key={s.key}
                        rowSpan={2}
                        className="ct-colhead ct-summary-head"
                      >
                        {s.label}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    {visColIdx.map((ci) => {
                      const c = result.columns[ci]
                      const key = catKey(c)
                      const grp = bannerGroupOf(c)
                      const editing =
                        advEdit?.kind === 'leaf' && advEdit.key === key
                      return (
                        <th
                          key={ci}
                          className={`ct-colhead${
                            selCats.has(key) ? ' ct-selected' : ''
                          }`}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setAdvMenu({
                              x: e.clientX,
                              y: e.clientY,
                              kind: 'leaf',
                              seg: c.seg ?? -1,
                              label: c.label,
                              group: c.group ?? '',
                            })
                          }}
                        >
                          {editing ? (
                            <input
                              className="cell-input ct-head-input"
                              autoFocus
                              value={advDraft}
                              onChange={(e) => setAdvDraft(e.target.value)}
                              onBlur={commitAdvEdit}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitAdvEdit()
                                else if (e.key === 'Escape') setAdvEdit(null)
                              }}
                            />
                          ) : (
                            <span
                              className={grp ? 'ct-group-head' : undefined}
                              onClick={(e) => {
                                if (e.metaKey || e.ctrlKey || e.shiftKey)
                                  toggleCat(key, true)
                              }}
                              onDoubleClick={() =>
                                startAdvEdit('leaf', key, dispLeaf(c))
                              }
                            >
                              {dispLeaf(c)}
                              {sigOn && lettersOn && c.letter && (
                                <span className="ct-col-letter">{c.letter}</span>
                              )}
                            </span>
                          )}
                        </th>
                      )
                    })}
                  </tr>
                </>
              ) : (
              <tr>
                <th className="ct-corner">
                  {cellStatLabels.map((label) => (
                    <span key={label} className="ct-legend-line">
                      {label}
                    </span>
                  ))}
                </th>
                {visColIdx.map((ci) => {
                  const c = result.columns[ci]
                  const isGroup = colGroupLabels.has(c.label)
                  const key = `col:${c.label}`
                  const editing =
                    headerEdit?.dim === 'col' && headerEdit.label === c.label
                  return (
                    <th
                      key={c.label}
                      className={`ct-colhead${dropTarget === key ? ' ct-drop' : ''}${
                        selCols.has(c.label) ? ' ct-selected' : ''
                      }`}
                      onDragOver={(e) => e.preventDefault()}
                      onDragEnter={() => setDropTarget(key)}
                      onDragLeave={() =>
                        setDropTarget((t) => (t === key ? null : t))
                      }
                      onDrop={(e) => onDropHeader(e, 'col', c.label)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setMenu({ x: e.clientX, y: e.clientY, dim: 'col', label: c.label })
                      }}
                    >
                      {editing ? (
                        <input
                          className="cell-input ct-head-input"
                          autoFocus
                          value={headerDraft}
                          onChange={(e) => setHeaderDraft(e.target.value)}
                          onBlur={commitHeaderEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitHeaderEdit()
                            else if (e.key === 'Escape') setHeaderEdit(null)
                          }}
                        />
                      ) : (
                        <span
                          className={isGroup ? 'ct-drag ct-group-head' : 'ct-drag'}
                          draggable
                          onDragStart={(e) => startDrag(e, 'col', c.label)}
                          onClick={
                            isGroup ? undefined : (e) => selectHeader('col', c.label, e)
                          }
                          onDoubleClick={() => startHeaderEdit('col', c.label)}
                        >
                          {dispCol(c.label)}
                          {sigOn && lettersOn && c.letter && (
                            <span className="ct-col-letter">{c.letter}</span>
                          )}
                        </span>
                      )}
                    </th>
                  )
                })}
                {activeSummaryCols.map((s) => (
                  <th key={s.key} className="ct-colhead ct-summary-head">
                    {s.label}
                  </th>
                ))}
              </tr>
              )}
            </thead>
            <tbody>
              {visRowIdx.map((ri) => {
                const label = result.row_labels[ri]
                const isGroup = rowGroupLabels.has(label)
                const key = `row:${label}`
                const editing =
                  headerEdit?.dim === 'row' && headerEdit.label === label
                return (
                  <tr key={label}>
                    <th
                      className={`ct-rowhead${dropTarget === key ? ' ct-drop' : ''}${
                        selRows.has(label) ? ' ct-selected' : ''
                      }`}
                      onDragOver={(e) => e.preventDefault()}
                      onDragEnter={() => setDropTarget(key)}
                      onDragLeave={() => setDropTarget((t) => (t === key ? null : t))}
                      onDrop={(e) => onDropHeader(e, 'row', label)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setMenu({ x: e.clientX, y: e.clientY, dim: 'row', label })
                      }}
                    >
                      {editing ? (
                        <input
                          className="cell-input ct-head-input"
                          autoFocus
                          value={headerDraft}
                          onChange={(e) => setHeaderDraft(e.target.value)}
                          onBlur={commitHeaderEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitHeaderEdit()
                            else if (e.key === 'Escape') setHeaderEdit(null)
                          }}
                        />
                      ) : (
                        <span
                          className={isGroup ? 'ct-drag ct-group-head' : 'ct-drag'}
                          draggable
                          onDragStart={(e) => startDrag(e, 'row', label)}
                          onClick={
                            isGroup ? undefined : (e) => selectHeader('row', label, e)
                          }
                          onDoubleClick={() => startHeaderEdit('row', label)}
                        >
                          {dispRow(label)}
                        </span>
                      )}
                    </th>
                    {visColIdx.map((ci) => {
                      const cell = result.cells[ri][ci]
                      const lines = cellLines(
                        cell.count,
                        result.columns[ci].base,
                        margins.rowTotals[ri],
                      )
                      const arrow = arrowsOn ? cell.sig_arrow : null
                      const beats =
                        lettersOn && cell.sig_higher ? cell.sig_higher : []
                      const cellKey = `${ri}:${ci}`
                      return (
                        <td
                          key={ci}
                          className={`ct-cell${
                            selCells.has(cellKey) ? ' ct-cell-selected' : ''
                          }`}
                          onClick={(e) => {
                            if (e.metaKey || e.ctrlKey) {
                              e.preventDefault()
                              toggleSel(cellKey)
                            }
                          }}
                        >
                          {lines.map((ln) => (
                            <span key={ln.key} className="ct-stat-line">
                              {ln.text}
                            </span>
                          ))}
                          {sigOn && (arrow || beats.length > 0) && (
                            <span className="ct-sig-line">
                              {arrow === 'up' && (
                                <span className="ct-arrow ct-arrow-up">▲</span>
                              )}
                              {arrow === 'down' && (
                                <span className="ct-arrow ct-arrow-down">▼</span>
                              )}
                              {beats.length > 0 && (
                                <span className="ct-sig-letters">
                                  {beats.join(' ')}
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                      )
                    })}
                    {activeSummaryCols.map((s) => (
                      <td key={s.key} className="ct-cell ct-summary">
                        {s.key === 'row_n' ? margins.rowTotals[ri] : ''}
                      </td>
                    ))}
                  </tr>
                )
              })}
              {activeSummaryRows.map((s) => (
                <tr key={s.key} className="ct-summary-row">
                  <th className="ct-rowhead ct-summary">{s.label}</th>
                  {visColIdx.map((ci) => {
                    const selectable = s.key === 'mean'
                    const meanKey = `mean:${ci}`
                    return (
                      <td
                        key={ci}
                        className={`ct-cell ct-summary${
                          selectable && selCells.has(meanKey)
                            ? ' ct-cell-selected'
                            : ''
                        }`}
                        onClick={
                          selectable
                            ? (e) => {
                                if (e.metaKey || e.ctrlKey) {
                                  e.preventDefault()
                                  toggleSel(meanKey)
                                }
                              }
                            : undefined
                        }
                      >
                        {summaryRowValue(s.key, ci)}
                      </td>
                    )
                  })}
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

          <p className="ct-caption">
            {result.weighted ? (
              <>
                Weighted
                {weightId
                  ? ` – ${
                      weightVars.find((w) => w.name === weightId)?.label ??
                      weightId
                    }`
                  : ''}
                , Total sample = {fmtCount(result.total_base)}
                {result.total_eff_base != null && (
                  <>
                    , Effective sample = {fmtCount(result.total_eff_base)},
                    Weighting efficiency ={' '}
                    {result.total_base
                      ? (
                          (result.total_eff_base / result.total_base) *
                          100
                        ).toFixed(1)
                      : '0.0'}
                    %
                  </>
                )}
              </>
            ) : (
              <>Unweighted, Total sample = {fmtCount(result.total_base)}</>
            )}
          </p>

          {sigOn && (
            <p className="ct-sig-legend">
              Significance at 95%:{' '}
              {arrowsOn && (
                <>
                  <span className="ct-arrow ct-arrow-up">▲</span>/
                  <span className="ct-arrow ct-arrow-down">▼</span> = higher/lower
                  than the rest of the sample
                </>
              )}
              {arrowsOn && lettersOn && '; '}
              {lettersOn && (
                <>letters = columns this cell is significantly higher than</>
              )}
              .
            </p>
          )}

          {(rowGroups.length > 0 || columnGroups.length > 0) && (
            <div className="ct-groups-panel">
              {rowGroups.length > 0 && (
                <div className="ct-group-col">
                  <strong>Row groups</strong>
                  {rowGroups.map((g) => (
                    <div key={g.id} className="ct-group-item">
                      <span className="badge">{g.mode}</span>
                      <input
                        className="cell-input"
                        value={g.label}
                        onChange={(e) => renameRowGroup(g.id, e.target.value)}
                      />
                      <span className="muted ct-group-members">
                        {g.members.join(', ')}
                      </span>
                      <button onClick={() => removeRowGroup(g.id)} title="Remove">
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {columnGroups.length > 0 && (
                <div className="ct-group-col">
                  <strong>Column groups</strong>
                  {columnGroups.map((g) => (
                    <div key={g.id} className="ct-group-item">
                      <span className="badge">{g.mode}</span>
                      <input
                        className="cell-input"
                        value={g.label}
                        onChange={(e) => renameColGroup(g.id, e.target.value)}
                      />
                      <span className="muted ct-group-members">
                        {g.members.join(', ')}
                      </span>
                      <button onClick={() => removeColGroup(g.id)} title="Remove">
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {(hiddenRowList.length > 0 || hiddenColList.length > 0) && (
            <div className="ct-hidden-panel">
              {hiddenRowList.length > 0 && (
                <div className="ct-hidden-line">
                  <strong>Hidden rows:</strong>
                  {hiddenRowList.map((l) => (
                    <button
                      key={l}
                      className="ct-chip"
                      onClick={() => unhide('row', l)}
                      title="Show"
                    >
                      {dispRow(l)} ✕
                    </button>
                  ))}
                </div>
              )}
              {hiddenColList.length > 0 && (
                <div className="ct-hidden-line">
                  <strong>Hidden columns:</strong>
                  {hiddenColList.map((l) => (
                    <button
                      key={l}
                      className="ct-chip"
                      onClick={() => unhide('col', l)}
                      title="Show"
                    >
                      {dispCol(l)} ✕
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {(hiddenCatList.length > 0 || hiddenParentList.length > 0) && (
            <div className="ct-hidden-panel">
              {hiddenParentList.length > 0 && (
                <div className="ct-hidden-line">
                  <strong>Hidden banner groups:</strong>
                  {hiddenParentList.map((p) => (
                    <button
                      key={p.group}
                      className="ct-chip"
                      onClick={() => unhideParent(p.group)}
                      title="Show"
                    >
                      {p.label} ✕
                    </button>
                  ))}
                </div>
              )}
              {hiddenCatList.length > 0 && (
                <div className="ct-hidden-line">
                  <strong>Hidden sub-columns:</strong>
                  {hiddenCatList.map((c) => (
                    <button
                      key={c.key}
                      className="ct-chip"
                      onClick={() => unhideCat(c.key)}
                      title="Show"
                    >
                      {c.label} ✕
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!result && !error && !loading && (
        <p className="muted">Choose a row and a column variable to build a table.</p>
      )}
      {menu &&
        (() => {
          const isGroup = (menu.dim === 'row' ? rowGroupLabels : colGroupLabels).has(
            menu.label,
          )
          const mode = (menu.dim === 'row' ? rowGroups : columnGroups).find(
            (g) => g.label === menu.label,
          )?.mode
          return (
            <>
              <div className="ct-menu-backdrop" onClick={() => setMenu(null)} />
              <div className="ct-menu" style={{ left: menu.x, top: menu.y }}>
                <button
                  onClick={() => {
                    hideItem(menu.dim, menu.label)
                    setMenu(null)
                  }}
                >
                  Hide
                </button>
                {isGroup && (
                  <>
                    <button
                      onClick={() => {
                        toggleGroupMode(menu.dim, menu.label)
                        setMenu(null)
                      }}
                    >
                      {mode === 'net' ? 'Show as merge' : 'Show as NET'}
                    </button>
                    <button
                      onClick={() => {
                        ungroup(menu.dim, menu.label)
                        setMenu(null)
                      }}
                    >
                      Ungroup
                    </button>
                  </>
                )}
              </div>
            </>
          )
        })()}
      {advMenu &&
        (() => {
          const grp =
            advMenu.kind === 'leaf'
              ? bannerGroups.find(
                  (g) => g.seg === advMenu.seg && g.label === advMenu.label,
                )
              : undefined
          return (
            <>
              <div className="ct-menu-backdrop" onClick={() => setAdvMenu(null)} />
              <div className="ct-menu" style={{ left: advMenu.x, top: advMenu.y }}>
                <button
                  onClick={() => {
                    if (advMenu.kind === 'leaf')
                      hideCat(`${advMenu.seg}${CATSEP}${advMenu.label}`)
                    else hideParent(advMenu.group)
                    setAdvMenu(null)
                  }}
                >
                  {advMenu.kind === 'parent' ? 'Hide group' : 'Hide'}
                </button>
                {grp && (
                  <>
                    <button
                      onClick={() => {
                        toggleBannerMode(advMenu.seg, advMenu.label)
                        setAdvMenu(null)
                      }}
                    >
                      {grp.mode === 'net' ? 'Show as merge' : 'Show as NET'}
                    </button>
                    <button
                      onClick={() => {
                        ungroupBanner(advMenu.seg, advMenu.label)
                        setAdvMenu(null)
                      }}
                    >
                      Ungroup
                    </button>
                  </>
                )}
              </div>
            </>
          )
        })()}
      </div>

      {sigTest && (
        <div className="modal-backdrop" onClick={() => setSigTest(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Significance test</h3>
              <button
                className="expand"
                onClick={() => setSigTest(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            {'error' in sigTest ? (
              <p className="error">{sigTest.error}</p>
            ) : (
              <>
                <p className="muted">
                  {sigTest.kind === 'mean'
                    ? 'Two-sample test of the two selected column means:'
                    : 'Two-proportion test of the two selected cells (column %):'}
                </p>
                <ul className="sig-compare">
                  <li>
                    {sigTest.labelA}:{' '}
                    <strong>
                      {sigTest.kind === 'mean'
                        ? sigTest.valueA.toFixed(2)
                        : `${sigTest.valueA.toFixed(1)}%`}
                    </strong>{' '}
                    (n = {Math.round(sigTest.nA)})
                  </li>
                  <li>
                    {sigTest.labelB}:{' '}
                    <strong>
                      {sigTest.kind === 'mean'
                        ? sigTest.valueB.toFixed(2)
                        : `${sigTest.valueB.toFixed(1)}%`}
                    </strong>{' '}
                    (n = {Math.round(sigTest.nB)})
                  </li>
                </ul>
                <p className={sigTest.significant ? 'sig-yes' : 'sig-no'}>
                  <strong>
                    {sigTest.significant ? 'Significant' : 'Not significant'}
                  </strong>{' '}
                  at the 95% confidence level (z = {sigTest.z.toFixed(2)}, p ={' '}
                  {sigTest.p < 0.001 ? '< 0.001' : sigTest.p.toFixed(3)}).
                </p>
              </>
            )}
            <div className="modal-actions">
              <button className="primary" onClick={() => setSigTest(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDelete && (
        <div className="modal-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Delete {confirmDelete.kind === 'folder' ? 'folder' : 'table'}</h3>
              <button
                className="expand"
                onClick={() => setConfirmDelete(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <p className="muted">
              {confirmDelete.kind === 'folder'
                ? `Delete "${confirmDelete.name}" and everything in it? This cannot be undone.`
                : `Delete "${confirmDelete.name}"? This cannot be undone.`}
            </p>
            <div className="modal-actions">
              <button onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="danger" onClick={confirmDeleteNode}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
