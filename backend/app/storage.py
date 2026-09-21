"""Persistence for imported datasets.

Each dataset is stored in its own folder under the data directory:
    data/datasets/<id>/data.parquet   -> the raw rows
    data/datasets/<id>/meta.json      -> the DatasetMeta (variables, labels, ...)

Parquet keeps the data compact and fast to reload, which sets us up for the
"save project / reopen later" milestone.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pandas as pd

from .models import DatasetMeta, DatasetSummary

# Data lives at the repository root under data/ (backend/ -> repo root -> data/).
DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "datasets"


def _dataset_dir(dataset_id: str) -> Path:
    return DATA_DIR / dataset_id


def _data_path(dataset_id: str) -> Path:
    return _dataset_dir(dataset_id) / "data.parquet"


def _meta_path(dataset_id: str) -> Path:
    return _dataset_dir(dataset_id) / "meta.json"


def create_dataset(df: pd.DataFrame, meta: DatasetMeta) -> None:
    """Write a dataset's rows and metadata to disk."""
    folder = _dataset_dir(meta.id)
    folder.mkdir(parents=True, exist_ok=True)
    df.to_parquet(_data_path(meta.id), index=False)
    _meta_path(meta.id).write_text(meta.model_dump_json(indent=2), encoding="utf-8")


def new_dataset_id() -> str:
    return uuid.uuid4().hex


def dataset_exists(dataset_id: str) -> bool:
    return _meta_path(dataset_id).exists()


def load_meta(dataset_id: str) -> DatasetMeta:
    return DatasetMeta.model_validate_json(
        _meta_path(dataset_id).read_text(encoding="utf-8")
    )


def save_meta(meta: DatasetMeta) -> None:
    _meta_path(meta.id).write_text(meta.model_dump_json(indent=2), encoding="utf-8")


def load_data(dataset_id: str) -> pd.DataFrame:
    return pd.read_parquet(_data_path(dataset_id))


def list_datasets() -> list[DatasetSummary]:
    """Return a summary of every stored dataset, newest first."""
    if not DATA_DIR.exists():
        return []
    summaries: list[tuple[float, DatasetSummary]] = []
    for folder in DATA_DIR.iterdir():
        meta_file = folder / "meta.json"
        if not meta_file.exists():
            continue
        meta = DatasetMeta.model_validate_json(meta_file.read_text(encoding="utf-8"))
        summaries.append(
            (
                meta_file.stat().st_mtime,
                DatasetSummary(
                    id=meta.id,
                    source_filename=meta.source_filename,
                    n_rows=meta.n_rows,
                    n_cols=meta.n_cols,
                ),
            )
        )
    summaries.sort(key=lambda item: item[0], reverse=True)
    return [summary for _, summary in summaries]
