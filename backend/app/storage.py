"""Persistence for data sets and projects.

Two layers so several analyses can sit on the same raw data (Displayr-style):
    data/sets/<data_id>/data.parquet        -> the raw rows (shared)
    data/sets/<data_id>/dataset.json        -> the DataSet record
    data/projects/<project_id>/project.json -> a DatasetMeta (the analysis)

A project references its DataSet by ``data_id``; ``load_data(project_id)`` resolves
that link, so the rest of the app keeps addressing everything by project id.
"""

from __future__ import annotations

import io
import json
import shutil
import uuid
import zipfile
from pathlib import Path

import pandas as pd

from .models import (
    DataGroup,
    DataSet,
    DatasetMeta,
    DatasetSummary,
    RefreshProjectImpact,
    RefreshReport,
)
from .template import apply_template

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


def create_dataset(
    df: pd.DataFrame, meta: DatasetMeta, source_format: str = "medallia"
) -> None:
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
            source_format=source_format,
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


def _unique_name(data_id: str, base: str) -> str:
    """Make ``base`` unique among a data set's project names (adds ' (n)')."""
    base = base or _unique_untitled(data_id)
    existing = {m.name for m in _all_projects() if m.data_id == data_id}
    if base not in existing:
        return base
    n = 1
    while f"{base} ({n})" in existing:
        n += 1
    return f"{base} ({n})"


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


# --- Portable project files (.statstool = a zip) ----------------------------


def export_project_zip(project_id: str, include_data: bool = True) -> bytes:
    """Bundle a project (and optionally its raw data) into a zip for download."""
    meta = load_meta(project_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "manifest.json",
            json.dumps(
                {
                    "version": 1,
                    "has_data": include_data,
                    "project_name": meta.name or meta.source_filename,
                    "source_filename": meta.source_filename,
                }
            ),
        )
        z.writestr("project.json", meta.model_dump_json(indent=2))
        if include_data and meta.data_id and data_exists(meta.data_id):
            data = load_data_record(meta.data_id)
            z.writestr("dataset.json", data.model_dump_json(indent=2))
            z.write(_data_path(meta.data_id), "data.parquet")
    return buf.getvalue()


def import_project_zip(raw: bytes) -> DatasetMeta:
    """Restore a project (with its data) from a ``.statstool`` zip under new ids."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise ValueError("That file is not a StatsTool project file.") from exc
    names = set(archive.namelist())
    if "project.json" not in names:
        raise ValueError("That file is not a StatsTool project file.")
    meta = DatasetMeta.model_validate_json(archive.read("project.json"))
    if "data.parquet" not in names or "dataset.json" not in names:
        raise ValueError(
            "This project file has no raw data. Opening analysis-only templates "
            "is coming soon."
        )
    data = DataSet.model_validate_json(archive.read("dataset.json"))
    data.id = new_dataset_id()
    folder = _set_dir(data.id)
    folder.mkdir(parents=True, exist_ok=True)
    _data_path(data.id).write_bytes(archive.read("data.parquet"))
    _dataset_path(data.id).write_text(data.model_dump_json(indent=2), encoding="utf-8")
    meta.id = new_dataset_id()
    meta.data_id = data.id
    create_project(meta)
    return meta


def template_info(raw: bytes) -> dict:
    """Peek inside a ``.statstool`` file to see if it carries raw data.

    Returns ``{"has_data", "name", "source_filename"}`` so the UI can decide
    whether to import it directly or apply it as a template onto a data set.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise ValueError("That file is not a StatsTool project file.") from exc
    names = set(archive.namelist())
    if "project.json" not in names:
        raise ValueError("That file is not a StatsTool project file.")
    meta = DatasetMeta.model_validate_json(archive.read("project.json"))
    has_data = "data.parquet" in names and "dataset.json" in names
    return {
        "has_data": has_data,
        "name": meta.name or meta.source_filename,
        "source_filename": meta.source_filename,
    }


def apply_template_zip(raw: bytes, target_data_id: str, name: str = "") -> DatasetMeta:
    """Apply a project file's analysis onto an existing data set (by column name)."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise ValueError("That file is not a StatsTool project file.") from exc
    if "project.json" not in set(archive.namelist()):
        raise ValueError("That file is not a StatsTool project file.")
    template = DatasetMeta.model_validate_json(archive.read("project.json"))
    if not data_exists(target_data_id):
        raise ValueError("That data set no longer exists.")
    target = load_data_record(target_data_id)
    meta = apply_template(template, target)
    meta.id = new_dataset_id()
    meta.name = _unique_name(target_data_id, name or meta.name)
    create_project(meta)
    return meta


def _count_crosstabs(nodes: list) -> int:
    """Count crosstab (non-folder) nodes anywhere in a saved-crosstab tree."""
    total = 0
    for n in nodes:
        if n.kind == "folder":
            total += _count_crosstabs(n.children)
        else:
            total += 1
    return total


def refresh_data(
    data_id: str,
    df: pd.DataFrame,
    base_variables: list,
    base_questions: list,
    source_filename: str,
    source_format: str,
    commit: bool,
) -> RefreshReport:
    """Replace a data set's rows (dry-run or commit) and re-fit its analyses.

    The new file's columns are matched to each analysis by name: edits on
    surviving columns are kept, missing columns prune whatever depends on them,
    and new columns appear as fresh raw variables. ``commit=False`` reports the
    impact without writing anything.
    """
    old = load_data_record(data_id)
    old_cols = [v.name for v in old.variables]
    new_cols = [v.name for v in base_variables]
    old_set, new_set = set(old_cols), set(new_cols)

    new_record = DataSet(
        id=data_id,
        source_filename=source_filename,
        n_rows=int(df.shape[0]),
        n_cols=int(df.shape[1]),
        source_format=source_format,
        variables=[v.model_copy(deep=True) for v in base_variables],
        questions=[q.model_copy(deep=True) for q in base_questions],
    )

    impacts: list[RefreshProjectImpact] = []
    refitted: list[DatasetMeta] = []
    for meta in _all_projects():
        if meta.data_id != data_id:
            continue
        new_meta = apply_template(meta, new_record)
        new_meta.id = meta.id
        new_meta.name = meta.name
        refitted.append(new_meta)
        impacts.append(
            RefreshProjectImpact(
                id=meta.id,
                name=meta.name or meta.source_filename,
                dropped_questions=max(0, len(meta.questions) - len(new_meta.questions)),
                dropped_filters=max(0, len(meta.filters) - len(new_meta.filters)),
                dropped_crosstabs=max(
                    0, _count_crosstabs(meta.crosstabs) - _count_crosstabs(new_meta.crosstabs)
                ),
            )
        )

    report = RefreshReport(
        old_rows=old.n_rows,
        new_rows=int(df.shape[0]),
        old_cols=old.n_cols,
        new_cols=int(df.shape[1]),
        added=[c for c in new_cols if c not in old_set],
        removed=[c for c in old_cols if c not in new_set],
        source_filename=source_filename,
        committed=False,
        projects=impacts,
    )
    if not commit:
        return report

    # Commit: back up the old rows, write the new ones atomically, then persist.
    data_path = _data_path(data_id)
    if data_path.exists():
        shutil.copy2(data_path, data_path.with_suffix(".parquet.bak"))
    tmp = data_path.with_suffix(".parquet.tmp")
    df.to_parquet(tmp, index=False)
    tmp.replace(data_path)
    _dataset_path(data_id).write_text(
        new_record.model_dump_json(indent=2), encoding="utf-8"
    )
    for new_meta in refitted:
        save_meta(new_meta)
    report.committed = True
    return report



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
                source_format=data.source_format,
                projects=ps,
            )
        )
    # Newest data first (by its most recent project).
    order = {p.data_id: i for i, p in enumerate(projects)}
    groups.sort(key=lambda g: order.get(g.data_id, 1e9))
    return groups
