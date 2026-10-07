"""FastAPI application entry point for StatsTool."""

from __future__ import annotations

import copy

import pandas as pd
from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from . import (
    askable,
    compute,
    crosstab as crosstabbing,
    detect,
    export as exporting,
    filters as filtering,
    ingest,
    storage,
)
from .models import (
    BandRecode,
    BandRequest,
    BinaryRecode,
    BinaryRequest,
    Combination,
    CombinationsRequest,
    CombinationsResponse,
    CopyRequest,
    CrosstabNode,
    CrosstabRequest,
    CrosstabResponse,
    CrosstabsUpdate,
    DataGroup,
    DatasetMeta,
    DatasetSummary,
    DistinctResponse,
    DistinctValue,
    ExportRequest,
    Filter,
    FilterCountResponse,
    FiltersUpdate,
    PreviewResponse,
    ProjectCreate,
    QuestionsUpdate,
    RefreshReport,
    Variable,
    VariablesUpdate,
    VariableType,
    WeightPreview,
    WeightRequest,
    WeightSpec,
)

app = FastAPI(title="StatsTool API", version="0.1.0")

# Allow the local Vite dev server to call this API during development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    """Simple check so the frontend can confirm the backend is running."""
    return {"status": "ok", "service": "StatsTool API"}


@app.get("/api/datasets", response_model=list[DatasetSummary])
def list_datasets() -> list[DatasetSummary]:
    """List every project so the user can reopen one."""
    return storage.list_datasets()


@app.get("/api/data", response_model=list[DataGroup])
def list_data_groups() -> list[DataGroup]:
    """List data sets grouped with the projects (analyses) built on each."""
    return storage.list_data_groups()


@app.post("/api/data/{data_id}/projects", response_model=DatasetMeta)
def new_project(data_id: str, payload: ProjectCreate) -> DatasetMeta:
    """Create a fresh project on an existing data set."""
    if not storage.data_exists(data_id):
        raise HTTPException(status_code=404, detail="Data set not found.")
    return storage.new_project(data_id, payload.name)


@app.post("/api/datasets/{dataset_id}/duplicate", response_model=DatasetMeta)
def duplicate_project(dataset_id: str, payload: ProjectCreate) -> DatasetMeta:
    """Copy a project (all its analysis) under a new id."""
    if not storage.dataset_exists(dataset_id):
        raise HTTPException(status_code=404, detail="Project not found.")
    return storage.duplicate_project(dataset_id, payload.name)


@app.put("/api/datasets/{dataset_id}/name", response_model=DatasetMeta)
def rename_project(dataset_id: str, payload: ProjectCreate) -> DatasetMeta:
    """Rename a project."""
    meta, _ = _load(dataset_id)
    meta.name = payload.name or meta.name
    storage.save_meta(meta)
    return meta


@app.delete("/api/datasets/{dataset_id}")
def delete_project(dataset_id: str) -> dict[str, str]:
    """Delete a project; also remove its data set when no projects remain."""
    if not storage.dataset_exists(dataset_id):
        raise HTTPException(status_code=404, detail="Project not found.")
    data_id = storage.load_meta(dataset_id).data_id
    storage.delete_project(dataset_id)
    if data_id and not storage.projects_for_data(data_id):
        storage.delete_data(data_id)
    return {"deleted": dataset_id}


@app.get("/api/datasets/{dataset_id}/export/project")
def export_project(dataset_id: str, include_data: bool = True) -> Response:
    """Download a project as a portable ``.statstool`` file (a zip)."""
    if not storage.dataset_exists(dataset_id):
        raise HTTPException(status_code=404, detail="Project not found.")
    meta = storage.load_meta(dataset_id)
    data = storage.export_project_zip(dataset_id, include_data)
    safe = (meta.name or meta.source_filename or "project").replace('"', "")
    return Response(
        content=data,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{safe}.statstool"'
        },
    )


@app.post("/api/projects/import")
async def import_project(file: UploadFile) -> dict:
    """Open a project from an uploaded ``.statstool`` file.

    Files that carry their raw data are imported straight away. Analysis-only
    files (saved without data) are templates: the caller must choose a data set
    to apply them to (``POST /api/data/{data_id}/apply-template``).
    """
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    try:
        info = storage.template_info(raw)
        if info["has_data"]:
            project = storage.import_project_zip(raw)
            return {"status": "imported", "project": project.model_dump()}
        return {"status": "needs_target", "name": info["name"]}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/data/{data_id}/apply-template", response_model=DatasetMeta)
async def apply_template(
    data_id: str, file: UploadFile, name: str = Form("")
) -> DatasetMeta:
    """Apply a project file's analysis onto an existing data set (by column name)."""
    if not storage.data_exists(data_id):
        raise HTTPException(status_code=404, detail="Data set not found.")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    try:
        return storage.apply_template_zip(raw, data_id, name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc



@app.post("/api/datasets", response_model=DatasetMeta)
async def upload_dataset(
    file: UploadFile, source_format: str = Form("medallia")
) -> DatasetMeta:
    """Import a survey file: parse it, infer metadata, and store it.

    ``source_format`` selects how the file is read: ``medallia`` (standard
    one-column-per-variable) or ``askable`` (repeating block layout reshaped into
    one variable per question).
    """
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    filename = file.filename or "uploaded.csv"
    df, variables, questions = _parse_upload(raw, source_format, filename)
    meta = DatasetMeta(
        id=storage.new_dataset_id(),
        source_filename=filename,
        n_rows=int(df.shape[0]),
        n_cols=int(df.shape[1]),
        variables=variables,
    )
    meta.questions = questions
    storage.create_dataset(df, meta, source_format=source_format)
    return meta


def _parse_upload(
    raw: bytes, source_format: str, filename: str
) -> tuple[pd.DataFrame, list[Variable], list["Question"]]:
    """Parse an uploaded survey file into a dataframe plus base metadata.

    Shared by import and data refresh so both read files the same way.
    """
    if source_format == "askable":
        try:
            header, body = askable.read_askable(raw)
        except Exception as exc:  # noqa: BLE001 - surface parse errors to the user
            raise HTTPException(
                status_code=400, detail=f"Could not read file: {exc}"
            ) from exc
        if not askable.is_askable(header):
            raise HTTPException(
                status_code=400,
                detail=(
                    "This does not look like an Askable export (no 'Block type' "
                    "columns found). Try the Medallia/standard format."
                ),
            )
        df, variables, questions = askable.reshape_askable(header, body)
    else:
        try:
            df = ingest.read_table(raw)
        except Exception as exc:  # noqa: BLE001 - surface parse errors to the user
            raise HTTPException(
                status_code=400, detail=f"Could not read file: {exc}"
            ) from exc
        variables = ingest.infer_variables(df)
        questions = detect.detect_questions(df, variables)
    if df.empty or df.shape[1] == 0:
        raise HTTPException(status_code=400, detail="No rows or columns found.")
    detect.apply_membership(variables, questions)
    return df, variables, questions


@app.post("/api/data/{data_id}/refresh", response_model=RefreshReport)
async def refresh_data(
    data_id: str,
    file: UploadFile,
    source_format: str = Form(""),
    commit: bool = Form(False),
) -> RefreshReport:
    """Replace a data set's rows with a new export, re-fitting its analyses.

    ``commit=false`` previews the impact without writing. ``source_format``
    defaults to how the data set was first imported.
    """
    if not storage.data_exists(data_id):
        raise HTTPException(status_code=404, detail="Data set not found.")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    filename = file.filename or "uploaded.csv"
    fmt = source_format or storage.load_data_record(data_id).source_format
    df, variables, questions = _parse_upload(raw, fmt, filename)
    try:
        return storage.refresh_data(
            data_id, df, variables, questions, filename, fmt, commit
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc



@app.get("/api/datasets/{dataset_id}", response_model=DatasetMeta)
def get_dataset(dataset_id: str) -> DatasetMeta:
    """Return a dataset's metadata (variables, labels, types)."""
    meta, _ = _load(dataset_id)
    return meta


@app.put("/api/datasets/{dataset_id}/variables", response_model=DatasetMeta)
def update_variables(dataset_id: str, payload: VariablesUpdate) -> DatasetMeta:
    """Save edited variable metadata (labels, types, values, recodes)."""
    meta, df = _load(dataset_id)
    _validate_variables(payload.variables, df)
    meta.variables = payload.variables
    # Questions are the source of truth for membership; keep tags in step.
    detect.apply_membership(meta.variables, meta.questions)
    storage.save_meta(meta)
    return meta


@app.put("/api/datasets/{dataset_id}/questions", response_model=DatasetMeta)
def update_questions(dataset_id: str, payload: QuestionsUpdate) -> DatasetMeta:
    """Save the dataset's matrix/grid questions (rename, retype, ungroup, edit)."""
    meta, _ = _load(dataset_id)
    names = {v.name for v in meta.variables}
    seen_ids: set[str] = set()
    for q in payload.questions:
        if q.id in seen_ids:
            raise HTTPException(status_code=400, detail=f"Duplicate question id: {q.id}")
        seen_ids.add(q.id)
        for item in q.items:
            if item.column not in names:
                raise HTTPException(
                    status_code=400,
                    detail=f"Unknown column in question '{q.label}': {item.column}",
                )
    meta.questions = payload.questions
    detect.apply_membership(meta.variables, meta.questions)
    storage.save_meta(meta)
    return meta


@app.post("/api/datasets/{dataset_id}/variables/copy", response_model=DatasetMeta)
def copy_variable(dataset_id: str, payload: CopyRequest) -> DatasetMeta:
    """Duplicate a variable into a new, independently editable one."""
    meta, df = _load(dataset_id)
    src = _require_variable(meta, payload.source_variable)
    existing = {v.name for v in meta.variables}

    if src.values:
        values = copy.deepcopy(src.values)
    else:
        underlying = compute.compute_display_series(
            df, compute.build_index(meta.variables), src
        )
        pairs, _, _, _ = compute.distinct_values(underlying)
        values = compute.seed_value_attributes(underlying) if len(pairs) <= 200 else []

    new_var = Variable(
        name=compute.unique_name(f"{src.name}_copy", existing),
        label=payload.new_label or f"{src.label} (copy)",
        type=src.type,
        source_name=src.name,
        values=values,
    )
    meta.variables.append(new_var)
    storage.save_meta(meta)
    return meta


@app.post("/api/datasets/{dataset_id}/variables/band", response_model=DatasetMeta)
def band_variable(dataset_id: str, payload: BandRequest) -> DatasetMeta:
    """Create a banded (ranged) variable from a numeric source."""
    meta, _ = _load(dataset_id)
    src = _require_variable(meta, payload.source_variable)
    if not payload.bands:
        raise HTTPException(status_code=400, detail="Provide at least one band.")

    recode = BandRecode(bands=payload.bands)
    existing = {v.name for v in meta.variables}
    new_var = Variable(
        name=compute.unique_name(f"{src.name}_band", existing),
        label=payload.new_label or f"{src.label} (banded)",
        type=VariableType.categorical,
        source_name=src.name,
        values=compute.band_value_attributes(payload.bands),
        recode=recode,
    )
    meta.variables.append(new_var)
    storage.save_meta(meta)
    return meta


@app.post("/api/datasets/{dataset_id}/variables/binary", response_model=DatasetMeta)
def binary_variable(dataset_id: str, payload: BinaryRequest) -> DatasetMeta:
    """Create a binary variable by choosing which values count as True."""
    meta, _ = _load(dataset_id)
    src = _require_variable(meta, payload.source_variable)
    if not payload.true_values:
        raise HTTPException(status_code=400, detail="Select at least one True value.")

    recode = BinaryRecode(
        true_values=payload.true_values,
        true_label=payload.true_label,
        false_label=payload.false_label,
    )
    existing = {v.name for v in meta.variables}
    new_var = Variable(
        name=compute.unique_name(f"{src.name}_binary", existing),
        label=payload.new_label or f"{src.label} ({payload.true_label})",
        type=VariableType.binary,
        source_name=src.name,
        values=compute.binary_value_attributes(recode),
        recode=recode,
    )
    meta.variables.append(new_var)
    storage.save_meta(meta)
    return meta


@app.post("/api/datasets/{dataset_id}/combinations", response_model=CombinationsResponse)
def variable_combinations(
    dataset_id: str, payload: CombinationsRequest
) -> CombinationsResponse:
    """Observed category combinations across variables, for building weight targets."""
    meta, df = _load(dataset_id)
    names = {v.name for v in meta.variables}
    for name in payload.variables:
        if name not in names:
            raise HTTPException(status_code=404, detail=f"Unknown variable: {name}")
    index = compute.build_index(meta.variables)
    combos = compute.combinations(
        df, index, payload.variables, payload.include_missing
    )
    total = sum(count for _values, count in combos) or 1
    return CombinationsResponse(
        combinations=[
            Combination(
                values=values, count=count, percent=round(count / total * 100, 2)
            )
            for values, count in combos
        ]
    )


def _validate_weight_spec(spec: WeightSpec, names: set[str]) -> None:
    """Reject an empty/invalid rim/rake spec (unknown vars, targets ≠ 100%)."""
    if not spec.rims:
        raise HTTPException(status_code=400, detail="Add at least one weighting rim.")
    for rim in spec.rims:
        if not rim.variables:
            raise HTTPException(status_code=400, detail="Each rim needs a variable.")
        for name in rim.variables:
            if name not in names:
                raise HTTPException(
                    status_code=400, detail=f"Unknown weighting variable: {name}"
                )
        # Targets must sum to 100% — reject rather than silently rescaling.
        if rim.cells:
            total = sum(c.percent for c in rim.cells)
            if abs(total - 100) > 0.5:
                where = " × ".join(rim.variables)
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Targets for {where} add to {total:.1f}%, not 100%. "
                        "Adjust them to total 100%."
                    ),
                )


@app.post(
    "/api/datasets/{dataset_id}/weight-preview", response_model=WeightPreview
)
def weight_preview(dataset_id: str, payload: WeightRequest) -> WeightPreview:
    """Compute sample-size diagnostics for a candidate weight without saving it."""
    meta, df = _load(dataset_id)
    names = {v.name for v in meta.variables}
    _validate_weight_spec(payload.spec, names)
    probe = Variable(
        name="__preview__",
        label=payload.new_label,
        type=VariableType.weight,
        weighting=payload.spec,
    )
    try:
        weights = compute.compute_weights(
            df, compute.build_index(meta.variables), probe
        )
    except Exception as err:
        raise HTTPException(
            status_code=400, detail=f"Weight could not be computed: {err}"
        ) from err
    included = weights[weights > 0]
    total = float(included.sum())
    eff = compute.effective_n(included)
    efficiency = (eff / total * 100) if total else 0.0
    return WeightPreview(
        total_sample=total, effective_sample=eff, efficiency=efficiency
    )


@app.post("/api/datasets/{dataset_id}/variables/weight", response_model=DatasetMeta)
def weight_variable(dataset_id: str, payload: WeightRequest) -> DatasetMeta:
    """Create or replace a rim/rake weight variable from a target definition."""
    meta, df = _load(dataset_id)
    names = {v.name for v in meta.variables}
    _validate_weight_spec(payload.spec, names)
    if payload.name:
        var = _require_variable(meta, payload.name)
        if var.type is not VariableType.weight:
            raise HTTPException(status_code=400, detail="Not a weight variable.")
        var.label = payload.new_label
        var.weighting = payload.spec
    else:
        existing = {v.name for v in meta.variables}
        var = Variable(
            name=compute.unique_name("weight", existing),
            label=payload.new_label,
            type=VariableType.weight,
            weighting=payload.spec,
        )
        meta.variables.append(var)

    try:
        compute.compute_weights(df, compute.build_index(meta.variables), var)
    except Exception as err:  # bad targets, unknown categories, etc.
        raise HTTPException(
            status_code=400, detail=f"Weight could not be computed: {err}"
        ) from err

    storage.save_meta(meta)
    return meta


@app.delete("/api/datasets/{dataset_id}/variables/{name}", response_model=DatasetMeta)
def delete_variable(dataset_id: str, name: str) -> DatasetMeta:
    """Delete a derived variable (raw imported columns cannot be deleted)."""
    meta, _ = _load(dataset_id)
    target = _require_variable(meta, name)
    if target.source_name is None and target.type is not VariableType.weight:
        raise HTTPException(
            status_code=400, detail="Imported columns cannot be deleted."
        )
    dependents = [v.name for v in meta.variables if v.source_name == name]
    if dependents:
        raise HTTPException(
            status_code=400,
            detail=f"Used by other variables: {', '.join(dependents)}.",
        )
    meta.variables = [v for v in meta.variables if v.name != name]
    storage.save_meta(meta)
    return meta


@app.get(
    "/api/datasets/{dataset_id}/variables/{name}/distinct",
    response_model=DistinctResponse,
)
def distinct_variable(dataset_id: str, name: str) -> DistinctResponse:
    """List a variable's distinct values, to build recode editors."""
    meta, df = _load(dataset_id)
    var = _require_variable(meta, name)
    series = compute.compute_display_series(df, compute.build_index(meta.variables), var)
    pairs, numeric, vmin, vmax = compute.distinct_values(series)
    order = compute.label_order(var)
    if order is not None:
        rank = {label: i for i, label in enumerate(order)}
        pairs.sort(key=lambda p: (rank.get(p[0], len(order)), p[0]))
    return DistinctResponse(
        values=[DistinctValue(value=v, count=c) for v, c in pairs],
        numeric=numeric,
        min=vmin,
        max=vmax,
    )


@app.put("/api/datasets/{dataset_id}/filters", response_model=DatasetMeta)
def update_filters(dataset_id: str, payload: FiltersUpdate) -> DatasetMeta:
    """Save the dataset's reusable filters."""
    meta, _ = _load(dataset_id)
    names = {v.name for v in meta.variables}
    ids = [f.id for f in payload.filters]
    if len(ids) != len(set(ids)):
        raise HTTPException(status_code=400, detail="Duplicate filter ids.")
    for filt in payload.filters:
        for cond in filt.conditions:
            if cond.variable not in names:
                raise HTTPException(
                    status_code=400,
                    detail=f"Filter '{filt.name}' uses unknown variable {cond.variable}.",
                )
    meta.filters = payload.filters
    storage.save_meta(meta)
    return meta


@app.post(
    "/api/datasets/{dataset_id}/filter-count", response_model=FilterCountResponse
)
def filter_count(dataset_id: str, filt: Filter) -> FilterCountResponse:
    """Count how many respondents an (unsaved) filter selects, for live feedback."""
    meta, df = _load(dataset_id)
    index = compute.build_index(meta.variables)
    mask = filtering.evaluate_filter(df, index, filt)
    return FilterCountResponse(count=int(mask.sum()), total=int(df.shape[0]))


@app.post(
    "/api/datasets/{dataset_id}/crosstab", response_model=CrosstabResponse
)
def crosstab(dataset_id: str, request: CrosstabRequest) -> CrosstabResponse:
    """Compute a crosstab of one row source against one column variable."""
    meta, df = _load(dataset_id)
    try:
        return crosstabbing.compute_crosstab(df, meta, request)
    except crosstabbing.CrosstabError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


def _collect_node_ids(nodes: list[CrosstabNode], seen: set[str]) -> None:
    """Walk the crosstab tree, failing on duplicate ids or bad node shapes."""
    for node in nodes:
        if node.id in seen:
            raise HTTPException(
                status_code=400, detail=f"Duplicate crosstab id: {node.id}"
            )
        seen.add(node.id)
        if node.kind == "crosstab" and node.spec is None:
            raise HTTPException(
                status_code=400, detail=f"Crosstab '{node.name}' has no spec."
            )
        _collect_node_ids(node.children, seen)


@app.put("/api/datasets/{dataset_id}/crosstabs", response_model=DatasetMeta)
def update_crosstabs(dataset_id: str, payload: CrosstabsUpdate) -> DatasetMeta:
    """Save the dataset's saved-crosstab tree (folders + crosstabs)."""
    meta, _ = _load(dataset_id)
    _collect_node_ids(payload.crosstabs, set())
    meta.crosstabs = payload.crosstabs
    storage.save_meta(meta)
    return meta


@app.post("/api/datasets/{dataset_id}/export/xlsx")
def export_xlsx(dataset_id: str, payload: ExportRequest) -> Response:
    """Export crosstabs to a single .xlsx workbook (grouped into worksheets)."""
    meta, df = _load(dataset_id)
    if not payload.sheets or not any(s.tables for s in payload.sheets):
        raise HTTPException(status_code=400, detail="No tables to export.")
    data = exporting.build_workbook(meta, df, payload.sheets)
    return Response(
        content=data,
        media_type=(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
        headers={
            "Content-Disposition": 'attachment; filename="statstool-export.xlsx"'
        },
    )


@app.get("/api/datasets/{dataset_id}/preview", response_model=PreviewResponse)
def preview_dataset(
    dataset_id: str, limit: int = 50, filter: str | None = None
) -> PreviewResponse:
    """Return the first `limit` rows with labels/recodes applied.

    When `filter` names a saved filter id, only matching respondents are shown.
    """
    meta, df = _load(dataset_id)
    limit = max(1, min(limit, 500))

    if filter:
        saved = next((f for f in meta.filters if f.id == filter), None)
        if saved is None:
            raise HTTPException(status_code=404, detail="Filter not found.")
        mask = filtering.evaluate_filter(df, compute.build_index(meta.variables), saved)
        df = df[mask]

    display = _display_frame(df.head(limit), meta)
    rows = [_clean_row(row) for row in display.to_dict(orient="records")]
    return PreviewResponse(
        columns=[v.name for v in meta.variables],
        rows=rows,
        total_rows=int(df.shape[0]),
    )


def _load(dataset_id: str) -> tuple[DatasetMeta, pd.DataFrame]:
    if not storage.dataset_exists(dataset_id):
        raise HTTPException(status_code=404, detail="Dataset not found.")
    return storage.load_meta(dataset_id), storage.load_data(dataset_id)


def _require_variable(meta: DatasetMeta, name: str) -> Variable:
    for var in meta.variables:
        if var.name == name:
            return var
    raise HTTPException(status_code=404, detail=f"Variable not found: {name}")


def _validate_variables(variables: list[Variable], df: pd.DataFrame) -> None:
    names = [v.name for v in variables]
    if len(names) != len(set(names)):
        raise HTTPException(status_code=400, detail="Duplicate variable names.")

    raw_columns = {str(c) for c in df.columns}
    # Weight variables are computed (no source column), so they aren't raw imports.
    raw_names = {
        v.name
        for v in variables
        if v.source_name is None and v.type is not VariableType.weight
    }
    if raw_names != raw_columns:
        raise HTTPException(
            status_code=400,
            detail="Every imported column must be present exactly once.",
        )
    name_set = set(names)
    for var in variables:
        if var.source_name is not None and var.source_name not in name_set:
            raise HTTPException(
                status_code=400,
                detail=f"{var.name} refers to a missing source: {var.source_name}.",
            )


def _display_frame(df: pd.DataFrame, meta: DatasetMeta) -> pd.DataFrame:
    index = compute.build_index(meta.variables)
    data = {v.name: compute.compute_display_series(df, index, v) for v in meta.variables}
    return pd.DataFrame(data)


def _clean_row(row: dict) -> dict:
    """Convert pandas/NaN values into JSON-serialisable equivalents."""
    cleaned: dict = {}
    for key, value in row.items():
        if isinstance(value, pd.Timestamp):
            cleaned[str(key)] = value.isoformat()
            continue
        try:
            if pd.isna(value):
                cleaned[str(key)] = None
                continue
        except (TypeError, ValueError):
            pass
        cleaned[str(key)] = value
    return cleaned
