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
}

export interface DatasetMeta {
  id: string
  source_filename: string
  n_rows: number
  n_cols: number
  variables: Variable[]
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

export function getPreview(id: string, limit = 50): Promise<PreviewResponse> {
  return fetch(`/api/datasets/${id}/preview?limit=${limit}`).then(
    handle<PreviewResponse>,
  )
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
