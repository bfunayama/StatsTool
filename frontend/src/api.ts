// Typed client for the StatsTool backend API.
// All requests go through the Vite dev proxy at /api (see vite.config.ts).

export type VariableType =
  | 'categorical'
  | 'numeric'
  | 'datetime'
  | 'text'
  | 'binary'

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

export interface Variable {
  name: string
  label: string
  type: VariableType
  source_name: string | null
  values: ValueAttribute[]
  recode: Recode | null
  question_id?: string | null
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
}

export interface CrosstabColumn {
  label: string
  base: number
}

export interface CrosstabResponse {
  row_labels: string[]
  columns: CrosstabColumn[]
  cells: CrosstabCell[][]
  total_base: number
  row_kind: 'variable' | 'multi' | 'grid' | 'grid2d'
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
  row: CrosstabRowSpec,
  column: string,
  filterId?: string | null,
): Promise<CrosstabResponse> {
  return postJson(`/api/datasets/${id}/crosstab`, {
    row,
    column,
    filter_id: filterId ?? null,
  })
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
