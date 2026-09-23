// Typed client for the StatsTool backend API.
// All requests go through the Vite dev proxy at /api (see vite.config.ts).

export type VariableType =
  | 'categorical'
  | 'numeric'
  | 'datetime'
  | 'text'
  | 'binary'
  | 'weight'

export interface ValueAttribute {
  source_value: string
  value: number | null
  label: string
  missing: boolean
}

export interface Band {
  min: number | null
  max: number | null
  label: string
}

export interface BandRecode {
  kind: 'band'
  bands: Band[]
}

export interface BinaryRecode {
  kind: 'binary'
  true_values: string[]
  true_label: string
  false_label: string
}

export type Recode = BandRecode | BinaryRecode

export interface WeightCell {
  values: string[]
  percent: number
}

export interface WeightRim {
  id: string
  variables: string[]
  missing: 'exclude' | 'category'
  cells: WeightCell[]
}

export interface WeightSpec {
  rims: WeightRim[]
  max_iter: number
}

export interface Variable {
  name: string
  label: string
  type: VariableType
  source_name: string | null
  values: ValueAttribute[]
  recode: Recode | null
  question_id?: string | null
  weighting?: WeightSpec | null
}

export interface Combination {
  values: string[]
  count: number
  percent: number
}

export type QuestionKind = 'multi' | 'grid' | 'grid2d'

export interface QuestionItem {
  column: string
  label: string
  row?: string | null
  col?: string | null
}

export interface AxisLabel {
  key: string
  label: string
}

export interface Question {
  id: string
  name: string
  label: string
  kind: QuestionKind
  items: QuestionItem[]
  categories: string[]
  rows: AxisLabel[]
  columns: AxisLabel[]
}

export interface DatasetMeta {
  id: string
  source_filename: string
  n_rows: number
  n_cols: number
  variables: Variable[]
  questions: Question[]
  filters: Filter[]
  crosstabs: CrosstabNode[]
}

export type Operator =
  | 'in'
  | 'not_in'
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'between'
  | 'is_missing'
  | 'not_missing'

export interface Condition {
  variable: string
  operator: Operator
  values: string[]
  number: number | null
  number2: number | null
  connector?: 'and' | 'or'
}

export interface Filter {
  id: string
  name: string
  match: 'all' | 'any'
  conditions: Condition[]
}

export interface FilterCountResponse {
  count: number
  total: number
}

export interface DatasetSummary {
  id: string
  source_filename: string
  n_rows: number
  n_cols: number
}

export interface PreviewResponse {
  columns: string[]
  rows: Record<string, string | number | null>[]
  total_rows: number
}

export interface DistinctValue {
  value: string
  count: number
}

export interface DistinctResponse {
  values: DistinctValue[]
  numeric: boolean
  min: number | null
  max: number | null
}

export interface CrosstabRowSpec {
  kind: 'variable' | 'question'
  ref: string
}

export interface CrosstabCell {
  count: number
  column_pct: number | null
  sig_higher?: string[]
  sig_arrow?: 'up' | 'down' | null
}

export interface CrosstabColumn {
  label: string
  base: number
  eff_base?: number | null
  letter?: string | null
  top_label?: string
  group?: string
  seg?: number
}

export interface CrosstabResponse {
  row_labels: string[]
  row_values: (number | null)[]
  columns: CrosstabColumn[]
  cells: CrosstabCell[][]
  total_base: number
  total_eff_base?: number | null
  weighted: boolean
  row_kind: 'variable' | 'multi' | 'grid' | 'grid2d'
}

export interface CrosstabDisplay {
  cell_stats: string[]
  summary_rows: string[]
  summary_cols: string[]
  significance?: string[]
}

export interface CrosstabGroup {
  id: string
  label: string
  members: string[]
  mode: 'net' | 'merge'
}

export interface BannerSegment {
  variables: string[]
}

export interface BannerColumnGroup {
  id: string
  seg: number
  label: string
  members: string[]
  mode: 'net' | 'merge'
}

export interface SavedCrosstabSpec {
  row: CrosstabRowSpec
  column: string | null
  banner?: BannerSegment[]
  banner_groups?: BannerColumnGroup[]
  filter_id: string | null
  weight: string | null
  display: CrosstabDisplay
  row_groups: CrosstabGroup[]
  column_groups: CrosstabGroup[]
  row_renames: Record<string, string>
  column_renames: Record<string, string>
  row_hidden: string[]
  column_hidden: string[]
  banner_cat_renames?: Record<string, string>
  banner_cat_hidden?: string[]
  banner_parent_renames?: Record<string, string>
  banner_parent_hidden?: string[]
}

export interface CrosstabNode {
  id: string
  name: string
  kind: 'folder' | 'crosstab'
  children: CrosstabNode[]
  spec: SavedCrosstabSpec | null
  version: number
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      if (body?.detail) detail = body.detail
    } catch {
      // response had no JSON body; keep the status text
    }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(handle<T>)
}

export function listDatasets(): Promise<DatasetSummary[]> {
  return fetch('/api/datasets').then(handle<DatasetSummary[]>)
}

export function uploadDataset(file: File): Promise<DatasetMeta> {
  const form = new FormData()
  form.append('file', file)
  return fetch('/api/datasets', { method: 'POST', body: form }).then(
    handle<DatasetMeta>,
  )
}

export function getDataset(id: string): Promise<DatasetMeta> {
  return fetch(`/api/datasets/${id}`).then(handle<DatasetMeta>)
}

export function updateVariables(
  id: string,
  variables: Variable[],
): Promise<DatasetMeta> {
  return fetch(`/api/datasets/${id}/variables`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variables }),
  }).then(handle<DatasetMeta>)
}

export function getPreview(
  id: string,
  limit = 50,
  filterId?: string,
): Promise<PreviewResponse> {
  const query = new URLSearchParams({ limit: String(limit) })
  if (filterId) query.set('filter', filterId)
  return fetch(`/api/datasets/${id}/preview?${query.toString()}`).then(
    handle<PreviewResponse>,
  )
}

export function saveFilters(
  id: string,
  filters: Filter[],
): Promise<DatasetMeta> {
  return fetch(`/api/datasets/${id}/filters`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters }),
  }).then(handle<DatasetMeta>)
}

export function saveQuestions(
  id: string,
  questions: Question[],
): Promise<DatasetMeta> {
  return fetch(`/api/datasets/${id}/questions`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questions }),
  }).then(handle<DatasetMeta>)
}

export function filterCount(
  id: string,
  filter: Filter,
): Promise<FilterCountResponse> {
  return postJson(`/api/datasets/${id}/filter-count`, filter)
}

export function runCrosstab(
  id: string,
  req: {
    row: CrosstabRowSpec
    column: string | null
    banner?: BannerSegment[]
    bannerGroups?: BannerColumnGroup[]
    filterId?: string | null
    weight?: string | null
    rowGroups?: CrosstabGroup[]
    columnGroups?: CrosstabGroup[]
  },
): Promise<CrosstabResponse> {
  return postJson(`/api/datasets/${id}/crosstab`, {
    row: req.row,
    column: req.column ?? null,
    banner: req.banner ?? [],
    banner_groups: req.bannerGroups ?? [],
    filter_id: req.filterId ?? null,
    weight: req.weight ?? null,
    row_groups: req.rowGroups ?? [],
    column_groups: req.columnGroups ?? [],
  })
}

export function getCombinations(
  id: string,
  variables: string[],
  includeMissing: boolean,
): Promise<Combination[]> {
  return postJson<{ combinations: Combination[] }>(
    `/api/datasets/${id}/combinations`,
    { variables, include_missing: includeMissing },
  ).then((r) => r.combinations)
}

export function saveWeight(
  id: string,
  spec: WeightSpec,
  newLabel: string,
  name?: string | null,
): Promise<DatasetMeta> {
  return postJson(`/api/datasets/${id}/variables/weight`, {
    name: name ?? null,
    new_label: newLabel,
    spec,
  })
}

export interface WeightPreview {
  total_sample: number
  effective_sample: number
  efficiency: number
}

export function previewWeight(
  id: string,
  spec: WeightSpec,
  newLabel: string,
): Promise<WeightPreview> {
  return postJson(`/api/datasets/${id}/weight-preview`, {
    name: null,
    new_label: newLabel,
    spec,
  })
}

export function saveCrosstabs(
  id: string,
  crosstabs: CrosstabNode[],
): Promise<DatasetMeta> {
  return fetch(`/api/datasets/${id}/crosstabs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ crosstabs }),
  }).then(handle<DatasetMeta>)
}

// Export one or more tables to a single .xlsx workbook and trigger a download.
export async function exportXlsx(
  id: string,
  tables: { name: string; spec: SavedCrosstabSpec }[],
): Promise<void> {
  const res = await fetch(`/api/datasets/${id}/export/xlsx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tables }),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.detail ?? 'Export failed')
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'statstool-export.xlsx'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function getDistinct(
  id: string,
  variable: string,
): Promise<DistinctResponse> {
  return fetch(
    `/api/datasets/${id}/variables/${encodeURIComponent(variable)}/distinct`,
  ).then(handle<DistinctResponse>)
}

export function copyVariable(
  id: string,
  source_variable: string,
  new_label?: string,
): Promise<DatasetMeta> {
  return postJson(`/api/datasets/${id}/variables/copy`, {
    source_variable,
    new_label: new_label ?? null,
  })
}

export function bandVariable(
  id: string,
  source_variable: string,
  bands: Band[],
  new_label?: string,
): Promise<DatasetMeta> {
  return postJson(`/api/datasets/${id}/variables/band`, {
    source_variable,
    bands,
    new_label: new_label ?? null,
  })
}

export function binaryVariable(
  id: string,
  source_variable: string,
  true_values: string[],
  options?: { true_label?: string; false_label?: string; new_label?: string },
): Promise<DatasetMeta> {
  return postJson(`/api/datasets/${id}/variables/binary`, {
    source_variable,
    true_values,
    true_label: options?.true_label ?? 'Selected',
    false_label: options?.false_label ?? 'Not selected',
    new_label: options?.new_label ?? null,
  })
}

export function deleteVariable(id: string, name: string): Promise<DatasetMeta> {
  return fetch(
    `/api/datasets/${id}/variables/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  ).then(handle<DatasetMeta>)
}
