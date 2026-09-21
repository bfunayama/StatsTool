// Typed client for the StatsTool backend API.
// All requests go through the Vite dev proxy at /api (see vite.config.ts).

export type VariableType = 'categorical' | 'numeric' | 'datetime' | 'text'

export interface ValueLabel {
  value: string
  label: string
}

export interface Variable {
  name: string
  label: string
  type: VariableType
  value_labels: ValueLabel[]
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
