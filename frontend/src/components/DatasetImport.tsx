import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteProject,
  duplicateProject,
  importProjectFile,
  listDataGroups,
  newProject,
  projectExportUrl,
  renameProject,
  uploadDataset,
  type DataGroup,
  type SourceFormat,
} from '../api'

interface Props {
  onOpen: (datasetId: string) => void
}

export function DatasetImport({ onOpen }: Props) {
  const [groups, setGroups] = useState<DataGroup[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [format, setFormat] = useState<SourceFormat>('medallia')
  const [importOpen, setImportOpen] = useState(false)
  const [pendingFormat, setPendingFormat] = useState<SourceFormat | null>(null)
  // In-app modals (native confirm/prompt are auto-dismissed in the shared browser).
  const [renameTarget, setRenameTarget] = useState<{
    projectId: string
    current: string
  } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{
    projectId: string
    name: string
    lastOnData: boolean
  } | null>(null)
  const [saveTarget, setSaveTarget] = useState<{
    projectId: string
    name: string
  } | null>(null)
  const [saveIncludeData, setSaveIncludeData] = useState(true)
  const fileInput = useRef<HTMLInputElement>(null)
  const projectInput = useRef<HTMLInputElement>(null)

  const reload = useCallback(() => {
    listDataGroups()
      .then(setGroups)
      .catch(() => setGroups([]))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  async function handleFile(file: File) {
    setBusy(true)
    setError(null)
    try {
      const meta = await uploadDataset(file, format)
      onOpen(meta.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  async function addProject(dataId: string) {
    try {
      const meta = await newProject(dataId)
      onOpen(meta.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create project')
    }
  }

  async function copyProject(projectId: string) {
    try {
      await duplicateProject(projectId)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not duplicate project')
    }
  }

  async function commitRename() {
    if (!renameTarget) return
    const next = renameDraft.trim()
    if (next === '' || next === renameTarget.current) {
      setRenameTarget(null)
      return
    }
    try {
      await renameProject(renameTarget.projectId, next)
      setRenameTarget(null)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename project')
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    try {
      await deleteProject(deleteTarget.projectId)
      setDeleteTarget(null)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete project')
    }
  }

  async function handleProjectFile(file: File) {
    setBusy(true)
    setError(null)
    try {
      const meta = await importProjectFile(file)
      onOpen(meta.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open project file')
    } finally {
      setBusy(false)
    }
  }

  function doSave() {
    if (!saveTarget) return
    const a = document.createElement('a')
    a.href = projectExportUrl(saveTarget.projectId, saveIncludeData)
    a.download = `${saveTarget.name}.statstool`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setSaveTarget(null)
  }

  return (
    <div className="panel">
      <h2>Import survey data</h2>
      <p className="muted">
        Load a .csv or tab-separated export. UTF-16 files (e.g. from Medallia)
        are handled automatically.
      </p>

      <input
        ref={fileInput}
        type="file"
        accept=".csv,.tsv,.txt"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFile(file)
          e.target.value = ''
        }}
      />
      <input
        ref={projectInput}
        type="file"
        accept=".statstool,.zip"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleProjectFile(file)
          e.target.value = ''
        }}
      />
      <div className="import-buttons">
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setPendingFormat(null)
            setImportOpen(true)
          }}
        >
          {busy ? 'Working…' : 'Import a data file'}
        </button>
        <button disabled={busy} onClick={() => projectInput.current?.click()}>
          Open project file…
        </button>
      </div>
      {error && <p className="error">{error}</p>}

      <h3 style={{ marginTop: '2rem' }}>Data sets &amp; projects</h3>
      {groups.length === 0 ? (
        <p className="muted">No data sets yet. Import a file to begin.</p>
      ) : (
        <div className="data-groups">
          {groups.map((g) => (
            <div key={g.data_id} className="data-group">
              <div className="data-group-head">
                <span className="data-group-name">{g.source_filename}</span>
                <span className="muted">
                  {g.n_rows} rows · {g.n_cols} columns · {g.projects.length}{' '}
                  project{g.projects.length === 1 ? '' : 's'}
                </span>
                <button onClick={() => addProject(g.data_id)}>
                  + New project
                </button>
              </div>
              <ul className="project-list">
                {g.projects.map((p) => (
                  <li key={p.id} className="project-row">
                    <button
                      className="project-open"
                      onClick={() => onOpen(p.id)}
                    >
                      {p.name || p.source_filename}
                    </button>
                    <span className="project-actions">
                      <button
                        onClick={() => {
                          setRenameDraft(p.name || p.source_filename)
                          setRenameTarget({
                            projectId: p.id,
                            current: p.name || p.source_filename,
                          })
                        }}
                      >
                        Rename
                      </button>
                      <button onClick={() => copyProject(p.id)}>Duplicate</button>
                      <button
                        onClick={() =>
                          setSaveTarget({
                            projectId: p.id,
                            name: p.name || p.source_filename,
                          })
                        }
                      >
                        Save file
                      </button>
                      <button
                        className="danger"
                        onClick={() =>
                          setDeleteTarget({
                            projectId: p.id,
                            name: p.name || p.source_filename,
                            lastOnData: g.projects.length === 1,
                          })
                        }
                      >
                        Delete
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {importOpen && (
        <div className="modal-backdrop" onClick={() => setImportOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Import a data file</h3>
            </div>
            <p className="muted">
              Choose the kind of export you&apos;re importing. This is required so
              each file is read correctly.
            </p>
            <label className="ct-check">
              <input
                type="radio"
                name="import-format"
                checked={pendingFormat === 'medallia'}
                onChange={() => setPendingFormat('medallia')}
              />
              Medallia export
              <span className="muted"> — standard, one column per question</span>
            </label>
            <label className="ct-check">
              <input
                type="radio"
                name="import-format"
                checked={pendingFormat === 'askable'}
                onChange={() => setPendingFormat('askable')}
              />
              Askable export
              <span className="muted">
                {' '}
                — block layout (Unmoderated or Survey), reshaped on import
              </span>
            </label>
            <div className="modal-actions">
              <button onClick={() => setImportOpen(false)}>Cancel</button>
              <button
                className="primary"
                disabled={pendingFormat === null}
                onClick={() => {
                  if (!pendingFormat) return
                  setFormat(pendingFormat)
                  setImportOpen(false)
                  fileInput.current?.click()
                }}
              >
                Choose file…
              </button>
            </div>
          </div>
        </div>
      )}

      {renameTarget && (
        <div className="modal-backdrop" onClick={() => setRenameTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Rename project</h3>
            </div>
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                else if (e.key === 'Escape') setRenameTarget(null)
              }}
              style={{ width: '100%' }}
            />
            <div className="modal-actions">
              <button onClick={() => setRenameTarget(null)}>Cancel</button>
              <button className="primary" onClick={commitRename}>
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Delete project</h3>
            </div>
            <p>
              Delete “{deleteTarget.name}”?
              {deleteTarget.lastOnData &&
                ' This is the last analysis on its data set, so the data will be removed too.'}
            </p>
            <div className="modal-actions">
              <button onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="danger" onClick={confirmDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {saveTarget && (
        <div className="modal-backdrop" onClick={() => setSaveTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Save project file</h3>
            </div>
            <p>
              Download “{saveTarget.name}” as a .statstool file you can reopen or
              share.
            </p>
            <label className="ct-check">
              <input
                type="checkbox"
                checked={saveIncludeData}
                onChange={(e) => setSaveIncludeData(e.target.checked)}
              />
              Include the raw data
              <span className="muted">
                {' '}
                — makes the file fully portable (larger). Uncheck for an
                analysis-only template.
              </span>
            </label>
            <div className="modal-actions">
              <button onClick={() => setSaveTarget(null)}>Cancel</button>
              <button className="primary" onClick={doSave}>
                Save file
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
