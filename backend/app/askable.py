"""Reshape Askable research exports into one-variable-per-question tables.

Askable (Unmoderated and Survey modules) lays each question out as a repeating
``Block type | Block name | Response(s) | Duration`` group, all on one row per
respondent. The question text lives in the data cells, not the header, so the
header has many duplicate names. We read positionally and pivot every block into
its own variable (matrix blocks become grid questions, variant comparisons become
a categorical + a pick-any), so the rest of the app works unchanged.
"""

from __future__ import annotations

import io
import re
import uuid

import pandas as pd

from . import ingest
from .compute import seed_value_attributes, unique_name
from .models import (
    Question,
    QuestionItem,
    QuestionKind,
    ValueAttribute,
    Variable,
    VariableType,
)

_BLOCK_MARKER = "Block type"
_NAME_MARKER = "Block name"
_DURATION_MARKER = "Duration"
_VARIANT_DIST = "Variant distribution"
_VARIANTS = "Variants"
_MAX_SCALE = 30  # a grid scale should have few distinct answers

# "7 - Extremely important" / "4 – Neutral" / bare "6": leading int is the code.
_CODED = re.compile(r"^\s*(-?\d+)\s*(?:[-\u2013]\s*.*)?$")


def read_askable(raw: bytes) -> tuple[list[str], pd.DataFrame]:
    """Decode the file and return (original header names, positional body).

    Read with ``header=None`` so pandas does not rename Askable's duplicate
    column names; the body uses integer column positions.
    """
    encoding = ingest._detect_encoding(raw)
    text = raw.decode(encoding, errors="replace")
    delimiter = ingest._detect_delimiter(text[:4096])
    full = pd.read_csv(
        io.StringIO(text),
        sep=delimiter,
        dtype=str,
        header=None,
        keep_default_na=True,
        na_values=[""],
    )
    header = ["" if pd.isna(h) else str(h) for h in full.iloc[0].tolist()]
    body = full.iloc[1:].reset_index(drop=True)
    body.columns = range(body.shape[1])
    return header, body


def is_askable(header: list[str]) -> bool:
    """An Askable export has the repeating ``Block type`` column marker."""
    return _BLOCK_MARKER in header


def _duration_to_seconds(value) -> int | None:
    """Convert an ``H:MM:SS`` (or ``MM:SS``) duration to whole seconds."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    text = str(value).strip()
    if not text:
        return None
    parts = text.split(":")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    seconds = 0
    for n in nums:
        seconds = seconds * 60 + n
    return seconds


def _first_value(series: pd.Series) -> str | None:
    """First non-empty cell of a column (block type/name are constant per block)."""
    for v in series:
        if v is not None and not (isinstance(v, float) and pd.isna(v)):
            text = str(v).strip()
            if text:
                return text
    return None


def _distinct(series: pd.Series) -> list[str]:
    s = series.astype("string").str.strip().replace("", pd.NA).dropna()
    return list(pd.unique(s))


def _mc_value_attributes(series: pd.Series) -> list[ValueAttribute]:
    """Value attributes for a multiple-choice column: leading int is the code."""
    attrs: list[ValueAttribute] = []
    for raw in _distinct(series):
        match = _CODED.match(raw)
        value = float(int(match.group(1))) if match else None
        attrs.append(ValueAttribute(source_value=raw, value=value, label=raw))
    attrs.sort(key=lambda a: (a.value is None, a.value if a.value is not None else 0, a.label))
    return attrs


def _scale_categories(body: pd.DataFrame, cols: list[int]) -> list[str]:
    """Union of distinct values across grid item columns (the shared scale)."""
    union: dict[str, int] = {}
    for ix in cols:
        for val in _distinct(body[ix]):
            union[val] = union.get(val, 0) + 1
    return sorted(union, key=lambda v: (-union[v], v))


class _Builder:
    """Accumulates reshaped columns, variables and questions by column position."""

    def __init__(self) -> None:
        self.columns: dict[str, pd.Series] = {}
        self.variables: list[Variable] = []
        self.questions: list[Question] = []
        self._used: set[str] = set()

    def _name(self, base: str) -> str:
        name = unique_name(base or "Column", self._used)
        self._used.add(name)
        return name

    def add_variable(
        self,
        base_name: str,
        label: str,
        series: pd.Series,
        var_type: VariableType,
        values: list[ValueAttribute] | None = None,
    ) -> str:
        name = self._name(base_name)
        self.columns[name] = series
        self.variables.append(
            Variable(
                name=name,
                label=label,
                type=var_type,
                values=values or [],
            )
        )
        return name

    def frame(self) -> pd.DataFrame:
        return pd.DataFrame(self.columns)


def _blocks(header: list[str], first: int) -> list[tuple[int, list[int]]]:
    """Split the block region into (block-type index, [subcolumn indices])."""
    blocks: list[tuple[int, list[int]]] = []
    i = first
    n = len(header)
    while i < n:
        if header[i] == _BLOCK_MARKER:
            j = i + 1
            sub: list[int] = []
            while j < n and header[j] != _BLOCK_MARKER:
                sub.append(j)
                j += 1
            blocks.append((i, sub))
            i = j
        else:
            i += 1
    return blocks


def _add_duration(b: _Builder, body: pd.DataFrame, dur_idx: int, block_name: str) -> None:
    seconds = body[dur_idx].map(_duration_to_seconds)
    series = seconds.map(lambda v: pd.NA if v is None else str(v))
    b.add_variable(
        f"{block_name} (duration, s)",
        f"{block_name} — time on task (seconds)",
        series,
        VariableType.numeric,
    )


def _add_standalone(b: _Builder, body: pd.DataFrame, idx: int, header_name: str) -> None:
    """A single plain column (profile or trailing screener): infer its type."""
    series = body[idx]
    label = header_name or f"Column {idx + 1}"
    inferred = ingest.infer_variable(label, series)
    b.add_variable(label, label, series, inferred.type, inferred.values)


def _add_variant(
    b: _Builder, body: pd.DataFrame, sub: list[int], header: list[str], block_name: str
) -> None:
    """A ``variant comparison`` block: distribution categorical + Variants pick-any."""
    dist_idx = next((ix for ix in sub if header[ix] == _VARIANT_DIST), None)
    var_idx = next((ix for ix in sub if header[ix] == _VARIANTS), None)
    if dist_idx is not None:
        series = body[dist_idx]
        b.add_variable(
            f"{block_name} (distribution)",
            f"{block_name} — distribution",
            series,
            VariableType.categorical,
            seed_value_attributes(series),
        )
    if var_idx is not None:
        _add_pick_any(b, body, var_idx, block_name)


def _add_pick_any(b: _Builder, body: pd.DataFrame, col_idx: int, block_name: str) -> None:
    """Split a comma-separated multi-answer column into pick-any member columns."""
    series = body[col_idx]
    items: list[str] = []
    seen: set[str] = set()
    for cell in series.dropna():
        for part in str(cell).split(","):
            name = part.strip()
            if name and name not in seen:
                seen.add(name)
                items.append(name)
    q_items: list[QuestionItem] = []
    for item in items:
        def present(cell, _item=item):
            if cell is None or (isinstance(cell, float) and pd.isna(cell)):
                return pd.NA
            parts = [p.strip() for p in str(cell).split(",")]
            return _item if _item in parts else pd.NA

        member = series.map(present)
        col = b.add_variable(
            f"{block_name}: {item}",
            item,
            member,
            VariableType.categorical,
            [ValueAttribute(source_value=item, value=1.0, label=item)],
        )
        q_items.append(QuestionItem(column=col, label=item))
    if q_items:
        b.questions.append(
            Question(
                id=uuid.uuid4().hex,
                name=block_name,
                label=block_name,
                kind=QuestionKind.multi,
                items=q_items,
            )
        )


def _add_matrix(
    b: _Builder, body: pd.DataFrame, cols: list[int], header: list[str], block_name: str
) -> None:
    """A ``matrix`` block: each statement column is a grid item sharing one scale."""
    q_items: list[QuestionItem] = []
    for ix in cols:
        statement = header[ix] or f"Item {ix + 1}"
        series = body[ix]
        col = b.add_variable(
            f"{block_name} :: {statement}",
            statement,
            series,
            VariableType.categorical,
            seed_value_attributes(series),
        )
        q_items.append(QuestionItem(column=col, label=statement))
    if q_items:
        b.questions.append(
            Question(
                id=uuid.uuid4().hex,
                name=block_name,
                label=block_name,
                kind=QuestionKind.grid,
                items=q_items,
                categories=_scale_categories(body, cols),
            )
        )


def reshape_askable(
    header: list[str], body: pd.DataFrame
) -> tuple[pd.DataFrame, list[Variable], list[Question]]:
    """Pivot an Askable export into a standard table plus variable/question metadata."""
    first = header.index(_BLOCK_MARKER)
    b = _Builder()

    # Profile columns (before the first block) pass through with inferred types.
    for idx in range(first):
        _add_standalone(b, body, idx, header[idx])

    for bidx, sub in _blocks(header, first):
        btype = (_first_value(body[bidx]) or "").lower()
        name_idx = sub[0] if sub else bidx
        block_name = _first_value(body[name_idx]) or header[name_idx] or "Question"
        resp_idxs = sub[1:]  # columns after "Block name"

        if btype == "variant comparison":
            _add_variant(b, body, sub, header, block_name)
            continue

        dur_pos = next(
            (k for k, ix in enumerate(resp_idxs) if header[ix] == _DURATION_MARKER),
            None,
        )
        if dur_pos is None:
            block_cols, dur_idx, trailing = resp_idxs, None, []
        else:
            block_cols = resp_idxs[:dur_pos]
            dur_idx = resp_idxs[dur_pos]
            trailing = resp_idxs[dur_pos + 1 :]

        if btype == "live website test":
            pass  # omitted entirely (no response captured)
        elif btype == "matrix":
            _add_matrix(b, body, block_cols, header, block_name)
            if dur_idx is not None:
                _add_duration(b, body, dur_idx, block_name)
        elif block_cols:
            col_idx = block_cols[0]
            series = body[col_idx]
            if btype == "opinion scale":
                b.add_variable(block_name, block_name, series, VariableType.numeric)
            elif btype == "open answer":
                b.add_variable(block_name, block_name, series, VariableType.text)
            else:  # multiple choice question (and any other single-response block)
                b.add_variable(
                    block_name,
                    block_name,
                    series,
                    VariableType.categorical,
                    _mc_value_attributes(series),
                )
            if dur_idx is not None:
                _add_duration(b, body, dur_idx, block_name)

        # Trailing standalone screener columns appended after this block's Duration.
        for ix in trailing:
            _add_standalone(b, body, ix, header[ix])

    return b.frame(), b.variables, b.questions
