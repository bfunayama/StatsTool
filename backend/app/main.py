"""FastAPI application entry point for StatsTool."""

from __future__ import annotations

import copy

import pandas as pd
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from . import compute, filters as filtering, ingest, storage
from .models import (
    BandRecode,
    BandRequest,
    BinaryRecode,
    BinaryRequest,
    CopyRequest,
    DatasetMeta,
    DatasetSummary,
    DistinctResponse,
    DistinctValue,
    Filter,
    FilterCountResponse,
    FiltersUpdate,
    PreviewResponse,
    Variable,
    VariablesUpdate,
    VariableType,
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
    """List every imported dataset so the user can reopen one."""
    return storage.list_datasets()


@app.post("/api/datasets", response_model=DatasetMeta)
async def upload_dataset(file: UploadFile) -> DatasetMeta:
    """Import a survey file: parse it, infer metadata, and store it."""
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    try:
        df = ingest.read_table(raw)
    except Exception as exc:  # noqa: BLE001 - surface parse errors to the user
        raise HTTPException(
            status_code=400, detail=f"Could not read file: {exc}"
        ) from exc

    if df.empty or df.shape[1] == 0:
        raise HTTPException(status_code=400, detail="No rows or columns found.")

    meta = DatasetMeta(
        id=storage.new_dataset_id(),
        source_filename=file.filename or "uploaded.csv",
        n_rows=int(df.shape[0]),
        n_cols=int(df.shape[1]),
        variables=ingest.infer_variables(df),
    )
    storage.create_dataset(df, meta)
    return meta


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


@app.delete("/api/datasets/{dataset_id}/variables/{name}", response_model=DatasetMeta)
def delete_variable(dataset_id: str, name: str) -> DatasetMeta:
    """Delete a derived variable (raw imported columns cannot be deleted)."""
    meta, _ = _load(dataset_id)
    target = _require_variable(meta, name)
    if target.source_name is None:
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
    raw_names = {v.name for v in variables if v.source_name is None}
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
