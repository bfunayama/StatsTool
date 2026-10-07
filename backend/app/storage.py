"""Persistence for data sets and projects.

Two layers so several analyses can sit on the same raw data (Displayr-style):
    data/sets/<data_id>/data.parquet        -> the raw rows (shared)
    data/sets/<data_id>/dataset.json        -> the DataSet record
    data/projects/<project_id>/project.json -> a DatasetMeta (the analysis)

A project references its DataSet by ``data_id``; ``load_data(project_id)`` resolves
that link, so the rest of the app keeps addressing everything by project id.
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

import pandas as pd

from .models import DataGroup, DataSet, DatasetMeta, DatasetSummary

_ROOT = Path(__file__).resolve().parents[2] / "data"
SETS_DIR = _ROOT / "sets"
PROJECTS_DIR = _ROOT / "projects"


def new_dataset_id() -> str:
    return uuid.uuid4().hex


# --- Data sets (raw rows) ---------------------------------------------------


def _set_dir(data_id: str) -> Path:
    return SETS_DIR / data_id


def _data_path(data_id: str) -> Path:
    return _set_dir(data_id) / "data.parquet"


def _dataset_path(data_id: str) -> Path:
    return _set_dir(data_id) / "dataset.json"


def create_data(df: pd.DataFrame, record: DataSet) -> None:
    """Write a data set's rows and record to disk."""
    folder = _set_dir(record.id)
    folder.mkdir(parents=True, exist_ok=True)
    df.to_parquet(_data_path(record.id), index=False)
    _dataset_path(record.id).write_text(
        record.model_dump_json(indent=2), encoding="utf-8"
    )


def load_data_record(data_id: str) -> DataSet:
    return DataSet.model_validate_json(
        _dataset_path(data_id).read_text(encoding="utf-8")
    )


def load_data_frame(data_id: str) -> pd.DataFrame:
    return pd.read_parquet(_data_path(data_id))


def data_exists(data_id: str) -> bool:
    return _dataset_path(data_id).exists()


def list_data() -> list[DataSet]:
    """Every stored data set."""
    if not SETS_DIR.exists():
        return []
    out: list[DataSet] = []
    for folder in SETS_DIR.iterdir():
        rec = folder / "dataset.json"
        if rec.exists():
            out.append(DataSet.model_validate_json(rec.read_text(encoding="utf-8")))
    return out


# --- Projects (analyses) ----------------------------------------------------


def _project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / project_id


def _project_path(project_id: str) -> Path:
    return _project_dir(project_id) / "project.json"


def create_project(meta: DatasetMeta) -> None:
    """Write a project's analysis metadata to disk."""
    folder = _project_dir(meta.id)
    folder.mkdir(parents=True, exist_ok=True)
    _project_path(meta.id).write_text(meta.model_dump_json(indent=2), encoding="utf-8")


def dataset_exists(project_id: str) -> bool:
    return _project_path(project_id).exists()


def load_meta(project_id: str) -> DatasetMeta:
    return DatasetMeta.model_validate_json(
        _project_path(project_id).read_text(encoding="utf-8")
    )


def save_meta(meta: DatasetMeta) -> None:
    _project_path(meta.id).write_text(meta.model_dump_json(indent=2), encoding="utf-8")


def load_data(project_id: str) -> pd.DataFrame:
    """Load the rows backing a project (resolved via its ``data_id``)."""
    meta = load_meta(project_id)
    return load_data_frame(meta.data_id)


def delete_project(project_id: str) -> None:
    folder = _project_dir(project_id)
    if folder.exists():
        shutil.rmtree(folder)


def delete_data(data_id: str) -> None:
    folder = _set_dir(data_id)
    if folder.exists():
        shutil.rmtree(folder)


def projects_for_data(data_id: str) -> list[str]:
    """Project ids that reference a given data set."""
    return [m.id for m in _all_projects() if m.data_id == data_id]


def create_dataset(df: pd.DataFrame, meta: DatasetMeta) -> None:
    """Import convenience: create a new DataSet from ``df`` and an initial project.

    ``meta.id`` is the project id; a fresh ``data_id`` is generated for the rows.
    """
    data_id = new_dataset_id()
    create_data(
        df,
        DataSet(
            id=data_id,
            source_filename=meta.source_filename,
            n_rows=meta.n_rows,
            n_cols=meta.n_cols,
            variables=[v.model_copy(deep=True) for v in meta.variables],
            questions=[q.model_copy(deep=True) for q in meta.questions],
        ),
    )
    meta.data_id = data_id
    if not meta.name:
        meta.name = meta.source_filename
    create_project(meta)


def _unique_untitled(data_id: str) -> str:
    """A fresh 'Untitled_Project' name unique among a data set's projects."""
    existing = {m.name for m in _all_projects() if m.data_id == data_id}
    base = "Untitled_Project"
    if base not in existing:
        return base
    n = 1
    while f"{base}({n})" in existing:
        n += 1
    return f"{base}({n})"


def new_project(data_id: str, name: str) -> DatasetMeta:
    """Create a fresh project from a data set's import-time base structure."""
    data = load_data_record(data_id)
    meta = DatasetMeta(
        id=new_dataset_id(),
        source_filename=data.source_filename,
        n_rows=data.n_rows,
        n_cols=data.n_cols,
        data_id=data_id,
        name=name or _unique_untitled(data_id),
        variables=[v.model_copy(deep=True) for v in data.variables],
        questions=[q.model_copy(deep=True) for q in data.questions],
    )
    create_project(meta)
    return meta


def duplicate_project(project_id: str, name: str) -> DatasetMeta:
    """Copy an entire project (variables, filters, saved tables) under a new id."""
    src = load_meta(project_id)
    meta = src.model_copy(deep=True)
    meta.id = new_dataset_id()
    meta.name = name or f"Copy of {src.name or src.source_filename}"
    create_project(meta)
    return meta


def _all_projects() -> list[DatasetMeta]:
    if not PROJECTS_DIR.exists():
        return []
    out: list[DatasetMeta] = []
    for folder in PROJECTS_DIR.iterdir():
        f = folder / "project.json"
        if f.exists():
            out.append(DatasetMeta.model_validate_json(f.read_text(encoding="utf-8")))
    return out


def list_datasets() -> list[DatasetSummary]:
    """Return a summary of every stored project, newest first."""
    if not PROJECTS_DIR.exists():
        return []
    summaries: list[tuple[float, DatasetSummary]] = []
    for folder in PROJECTS_DIR.iterdir():
        meta_file = folder / "project.json"
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
                    data_id=meta.data_id,
                    name=meta.name or meta.source_filename,
                ),
            )
        )
    summaries.sort(key=lambda item: item[0], reverse=True)
    return [summary for _, summary in summaries]


def list_data_groups() -> list[DataGroup]:
    """Data sets, each with the projects built on them (newest project first)."""
    projects = list_datasets()  # already newest-first
    by_data: dict[str, list[DatasetSummary]] = {}
    for p in projects:
        by_data.setdefault(p.data_id, []).append(p)
    groups: list[DataGroup] = []
    for data in list_data():
        ps = by_data.get(data.id, [])
        if not ps:
            continue
        groups.append(
            DataGroup(
                data_id=data.id,
                source_filename=data.source_filename,
                n_rows=data.n_rows,
                n_cols=data.n_cols,
                projects=ps,
            )
        )
    # Newest data first (by its most recent project).
    order = {p.data_id: i for i, p in enumerate(projects)}
    groups.sort(key=lambda g: order.get(g.data_id, 1e9))
    return groups
