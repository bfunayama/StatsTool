import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyTemplate,
  deleteProject,
  duplicateProject,
  importProjectFile,
  listDataGroups,
  newProject,
  projectExportUrl,
  refreshData,
  renameProject,
  uploadDataset,
  type DataGroup,
  type RefreshReport,
  type SourceFormat,
} from '../api'
import { useBackdropDismiss } from '../useBackdropDismiss'

interface Props {
  onOpen: (datasetId: string) => void
}

export function DatasetImport({ onOpen }: Props) {
  const backdrop = useBackdropDismiss()
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
  // An analysis-only project file waiting for the user to pick a data set.
  const [templatePending, setTemplatePending] = useState<{
    file: File
    name: string
  } | null>(null)
  // Data set chosen to receive a project file (reverse flow).
  const [templateDataId, setTemplateDataId] = useState<string | null>(null)
  // In-place data refresh (update a data set's rows/columns).
  const [refreshTarget, setRefreshTarget] = useState<{
    dataId: string
    sourceFilename: string
  } | null>(null)
  const [refreshFile, setRefreshFile] = useState<File | null>(null)
  const [refreshFormat, setRefreshFormat] = useState<SourceFormat>('medallia')
  const [refreshReport, setRefreshReport] = useState<RefreshReport | null>(null)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const projectInput = useRef<HTMLInputElement>(null)
  const templateInput = useRef<HTMLInputElement>(null)
  const refreshInput = useRef<HTMLInputElement>(null)

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
      const result = await importProjectFile(file)
      if (result.status === 'imported') {
        onOpen(result.project.id)
      } else {
        // Analysis-only file: ask which data set to apply it to.
        setTemplatePending({ file, name: result.name })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open project file')
    } finally {
      setBusy(false)
    }
  }

  async function applyTemplateTo(dataId: string) {
    if (!templatePending) return
    setBusy(true)
    setError(null)
    try {
      const meta = await applyTemplate(
        dataId,
        templatePending.file,
        templatePending.name,
      )
      setTemplatePending(null)
      onOpen(meta.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply template')
    } finally {
      setBusy(false)
    }
  }

  async function handleProjectFileForData(file: File) {
    if (!templateDataId) return
    setBusy(true)
    setError(null)
    try {
      const meta = await applyTemplate(templateDataId, file)
      onOpen(meta.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply project file')
    } finally {
      setBusy(false)
    }
  }

  function closeRefresh() {
    setRefreshTarget(null)
    setRefreshFile(null)
    setRefreshReport(null)
    setRefreshError(null)
  }

  async function previewRefresh() {
    if (!refreshTarget || !refreshFile) return
    setRefreshBusy(true)
    setRefreshError(null)
    try {
      const report = await refreshData(
        refreshTarget.dataId,
        refreshFile,
        refreshFormat,
        false,
      )
      setRefreshReport(report)
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Could not read file')
    } finally {
      setRefreshBusy(false)
    }
  }

  async function commitRefresh() {
    if (!refreshTarget || !refreshFile) return
    setRefreshBusy(true)
    setRefreshError(null)
    try {
      await refreshData(refreshTarget.dataId, refreshFile, refreshFormat, true)
      closeRefresh()
      reload()
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Could not update data')
    } finally {
      setRefreshBusy(false)
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
      <input
        ref={templateInput}
        type="file"
        accept=".statstool,.zip"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleProjectFileForData(file)
          e.target.value = ''
        }}
      />
      <input
        ref={refreshInput}
        type="file"
        accept=".csv,.tsv,.txt"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) {
            setRefreshReport(null)
            setRefreshError(null)
            setRefreshFile(file)
          }
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
          Open project file
        </button>
      </div>
      {error && <p className="error">{error}</p>}

      <h3 style={{ marginTop: '2rem' }}>Projects</h3>
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
                  New analysis
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setRefreshTarget({
                      dataId: g.data_id,
                      sourceFilename: g.source_filename,
                    })
                    setRefreshFormat(g.source_format)
                    setRefreshFile(null)
                    setRefreshReport(null)
                    setRefreshError(null)
                    refreshInput.current?.click()
                  }}
                >
                  Update data
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setTemplateDataId(g.data_id)
                    templateInput.current?.click()
                  }}
                >
                  Connect analysis file
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
                        Download
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
        <div className="modal-backdrop" {...backdrop(() => setImportOpen(false))}>
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
        <div className="modal-backdrop" {...backdrop(() => setRenameTarget(null))}>
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
        <div className="modal-backdrop" {...backdrop(() => setDeleteTarget(null))}>
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
        <div className="modal-backdrop" {...backdrop(() => setSaveTarget(null))}>
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

      {templatePending && (
        <div
          className="modal-backdrop"
          {...backdrop(() => setTemplatePending(null))}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Apply template to a data set</h3>
            </div>
            <p className="muted">
              “{templatePending.name}” has no raw data, so it is a template.
              Choose a data set to apply its analysis to — variables, questions,
              filters and tables are matched by column name, and anything that
              doesn&apos;t match is left out.
            </p>
            {groups.length === 0 ? (
              <p className="muted">
                No data sets yet. Import a data file first, then apply the
                template.
              </p>
            ) : (
              <ul className="template-targets">
                {groups.map((g) => (
                  <li key={g.data_id}>
                    <button
                      disabled={busy}
                      onClick={() => applyTemplateTo(g.data_id)}
                    >
                      <span>{g.source_filename}</span>
                      <span className="muted">
                        {g.n_rows} rows · {g.n_cols} columns
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button onClick={() => setTemplatePending(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {refreshTarget && refreshFile && (
        <div className="modal-backdrop" {...backdrop(closeRefresh)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Update data set</h3>
            </div>
            <p className="muted">
              Replace the data behind “{refreshTarget.sourceFilename}” with{' '}
              <strong>{refreshFile.name}</strong>. Every analysis on this data set
              updates; a one-level backup of the current data is kept.
            </p>
            <fieldset className="import-format">
              <legend>File type</legend>
              <label className="ct-check">
                <input
                  type="radio"
                  name="refresh-format"
                  checked={refreshFormat === 'medallia'}
                  onChange={() => {
                    setRefreshFormat('medallia')
                    setRefreshReport(null)
                  }}
                />
                Medallia export
              </label>
              <label className="ct-check">
                <input
                  type="radio"
                  name="refresh-format"
                  checked={refreshFormat === 'askable'}
                  onChange={() => {
                    setRefreshFormat('askable')
                    setRefreshReport(null)
                  }}
                />
                Askable export
              </label>
            </fieldset>

            {refreshReport && (
              <div className="refresh-report">
                <p>
                  Rows: {refreshReport.old_rows} → <strong>{refreshReport.new_rows}</strong>
                  {'  ·  '}
                  Columns: {refreshReport.old_cols} → <strong>{refreshReport.new_cols}</strong>
                </p>
                <p className="muted">
                  {refreshReport.added.length} added
                  {refreshReport.added.length > 0 &&
                    `: ${refreshReport.added.slice(0, 8).join(', ')}${
                      refreshReport.added.length > 8 ? '…' : ''
                    }`}
                  {'  ·  '}
                  {refreshReport.removed.length} removed
                  {refreshReport.removed.length > 0 &&
                    `: ${refreshReport.removed.slice(0, 8).join(', ')}${
                      refreshReport.removed.length > 8 ? '…' : ''
                    }`}
                </p>
                {refreshReport.projects.some(
                  (p) =>
                    p.dropped_questions + p.dropped_filters + p.dropped_crosstabs >
                    0,
                ) && (
                  <div className="refresh-impact">
                    <strong>Impact on your analyses</strong>
                    <ul>
                      {refreshReport.projects
                        .filter(
                          (p) =>
                            p.dropped_questions +
                              p.dropped_filters +
                              p.dropped_crosstabs >
                            0,
                        )
                        .map((p) => (
                          <li key={p.id}>
                            {p.name} —{' '}
                            {[
                              p.dropped_questions &&
                                `${p.dropped_questions} question${p.dropped_questions === 1 ? '' : 's'}`,
                              p.dropped_filters &&
                                `${p.dropped_filters} filter${p.dropped_filters === 1 ? '' : 's'}`,
                              p.dropped_crosstabs &&
                                `${p.dropped_crosstabs} table${p.dropped_crosstabs === 1 ? '' : 's'}`,
                            ]
                              .filter(Boolean)
                              .join(', ')}{' '}
                            removed (columns no longer in the data)
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
                {refreshReport.removed.length === 0 &&
                  refreshReport.projects.every(
                    (p) =>
                      p.dropped_questions +
                        p.dropped_filters +
                        p.dropped_crosstabs ===
                      0,
                  ) && (
                    <p className="muted">
                      No columns removed — all analyses carry over unchanged.
                    </p>
                  )}
                <p className="muted">
                  Any new category values will show unlabelled until you set them.
                </p>
              </div>
            )}

            {refreshError && <p className="error">{refreshError}</p>}

            <div className="modal-actions">
              <button onClick={closeRefresh}>Cancel</button>
              {refreshReport ? (
                <button
                  className="primary"
                  disabled={refreshBusy}
                  onClick={commitRefresh}
                >
                  {refreshBusy ? 'Updating…' : 'Update data'}
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={refreshBusy}
                  onClick={previewRefresh}
                >
                  {refreshBusy ? 'Reading…' : 'Preview changes'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
