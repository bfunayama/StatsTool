"""FastAPI application entry point for StatsTool."""

from __future__ import annotations

import math

import pandas as pd
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from . import ingest, storage
from .models import (
    DatasetMeta,
    DatasetSummary,
    PreviewResponse,
    VariablesUpdate,
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
    if not storage.dataset_exists(dataset_id):
        raise HTTPException(status_code=404, detail="Dataset not found.")
    return storage.load_meta(dataset_id)


@app.put("/api/datasets/{dataset_id}/variables", response_model=DatasetMeta)
def update_variables(dataset_id: str, payload: VariablesUpdate) -> DatasetMeta:
    """Save edited variable metadata (labels, types, value labels)."""
    if not storage.dataset_exists(dataset_id):
        raise HTTPException(status_code=404, detail="Dataset not found.")

    meta = storage.load_meta(dataset_id)
    known = {v.name for v in meta.variables}
    incoming = {v.name for v in payload.variables}
    if incoming != known:
        raise HTTPException(
            status_code=400,
            detail="Variable list must match the dataset's columns.",
        )

    meta.variables = payload.variables
    storage.save_meta(meta)
    return meta


@app.get("/api/datasets/{dataset_id}/preview", response_model=PreviewResponse)
def preview_dataset(dataset_id: str, limit: int = 50) -> PreviewResponse:
    """Return the first `limit` rows for previewing the data."""
    if not storage.dataset_exists(dataset_id):
        raise HTTPException(status_code=404, detail="Dataset not found.")

    limit = max(1, min(limit, 500))
    df = storage.load_data(dataset_id)
    head = df.head(limit)
    rows = [_clean_row(row) for row in head.to_dict(orient="records")]
    return PreviewResponse(
        columns=[str(c) for c in df.columns],
        rows=rows,
        total_rows=int(df.shape[0]),
    )


def _clean_row(row: dict) -> dict:
    """Convert pandas/NaN values into JSON-serialisable equivalents."""
    cleaned: dict = {}
    for key, value in row.items():
        if value is None or (isinstance(value, float) and math.isnan(value)):
            cleaned[str(key)] = None
        elif isinstance(value, pd.Timestamp):
            cleaned[str(key)] = value.isoformat()
        else:
            cleaned[str(key)] = value
    return cleaned
