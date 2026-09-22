"""Detect matrix/grid questions (Displayr-style variable sets) at import time.

Survey exports spread a single grid question across many columns that share a
name prefix, e.g. ``BupaAware. Bupa Extras cover`` (pick-any) or
``KanoFunctional1``..``KanoFunctional8`` (a shared scale). We group these by
prefix and then confirm the shape from the data before creating a question, so
detection needs both a naming pattern and a matching value structure.
"""

from __future__ import annotations

import re
import uuid

import pandas as pd

from .models import AxisLabel, Question, QuestionItem, QuestionKind, Variable

# Two numeric indices (e.g. BupaVisited.1.1) are a 2-D grid: row.column cell.
_TWO_INDEX = re.compile(r"^(?P<prefix>.+?)\.(?P<row>\d+)\.(?P<col>\d+)$")
# "Prefix. Option text" — a dot then non-numeric text (pick-any option).
_DOT_TEXT = re.compile(r"^(?P<prefix>.+?)\.\s*(?P<suffix>\D.*)$")
# "Prefix1" or "Prefix.1" — an optional dot then a trailing number (grid row).
_NUM_SUFFIX = re.compile(r"^(?P<prefix>.+?)\.?(?P<suffix>\d+)$")

_MIN_MEMBERS = 3  # avoid grouping incidental pairs
_MAX_SCALE = 30  # a single-select scale should have few distinct answers


def _prefix_suffix(name: str) -> tuple[str, str] | None:
    """Split a column name into (question prefix, member suffix), or None."""
    if _TWO_INDEX.match(name):
        return None
    m = _DOT_TEXT.match(name)
    if m:
        return m.group("prefix").strip(), m.group("suffix").strip()
    m = _NUM_SUFFIX.match(name)
    if m:
        return m.group("prefix").strip().rstrip("."), m.group("suffix").strip()
    return None


def _distinct(series: pd.Series) -> list[str]:
    s = series.astype("string").str.strip().replace("", pd.NA).dropna()
    return list(pd.unique(s))


def _scale_categories(df: pd.DataFrame, columns: list[str]) -> list[str] | None:
    """Union of distinct values across ``columns`` if it looks like a shared scale."""
    union: dict[str, int] = {}
    for col in columns:
        for val in _distinct(df[col]):
            union[val] = union.get(val, 0) + 1
    if not 1 <= len(union) <= _MAX_SCALE:
        return None
    return sorted(union, key=lambda v: (-union[v], v))


def _detect_grid2d(df: pd.DataFrame) -> list[Question]:
    """Group ``Prefix.row.col`` columns into two-dimensional grid questions."""
    groups: dict[str, list[tuple[str, str, str]]] = {}
    for col in (str(c) for c in df.columns):
        m = _TWO_INDEX.match(col)
        if not m:
            continue
        prefix = m.group("prefix").strip().rstrip(".")
        groups.setdefault(prefix, []).append((col, m.group("row"), m.group("col")))

    questions: list[Question] = []
    for prefix, members in groups.items():
        if len(members) < _MIN_MEMBERS:
            continue
        row_keys = sorted({r for _, r, _ in members}, key=int)
        col_keys = sorted({c for _, _, c in members}, key=int)
        if len(row_keys) < 2 or len(col_keys) < 2:
            continue
        categories = _scale_categories(df, [c for c, _, _ in members])
        if categories is None:
            continue
        questions.append(
            Question(
                id=uuid.uuid4().hex,
                name=prefix,
                label=prefix,
                kind=QuestionKind.grid2d,
                items=[
                    QuestionItem(column=col, label=col, row=r, col=c)
                    for col, r, c in members
                ],
                categories=categories,
                rows=[AxisLabel(key=k, label=k) for k in row_keys],
                columns=[AxisLabel(key=k, label=k) for k in col_keys],
            )
        )
    return questions


def detect_questions(df: pd.DataFrame, variables: list[Variable]) -> list[Question]:
    """Group columns into matrix/grid questions using name prefixes + values."""
    questions: list[Question] = _detect_grid2d(df)

    groups: dict[str, list[tuple[str, str]]] = {}
    order: list[str] = []
    for col in (str(c) for c in df.columns):
        parsed = _prefix_suffix(col)
        if parsed is None:
            continue
        prefix, suffix = parsed
        if prefix not in groups:
            groups[prefix] = []
            order.append(prefix)
        groups[prefix].append((col, suffix))

    for prefix in order:
        members = groups[prefix]
        if len(members) < _MIN_MEMBERS:
            continue
        distinct_by_col = {col: _distinct(df[col]) for col, _ in members}
        items = [QuestionItem(column=col, label=suffix or col) for col, suffix in members]

        # Pick-any: each column holds a single option (its label) or is blank.
        if all(len(vals) <= 1 for vals in distinct_by_col.values()):
            questions.append(
                Question(
                    id=uuid.uuid4().hex,
                    name=prefix,
                    label=prefix,
                    kind=QuestionKind.multi,
                    items=items,
                )
            )
            continue

        # Single-select grid: members share one small categorical scale.
        categories = _scale_categories(df, [col for col, _ in members])
        if categories is not None and len(categories) >= 2:
            questions.append(
                Question(
                    id=uuid.uuid4().hex,
                    name=prefix,
                    label=prefix,
                    kind=QuestionKind.grid,
                    items=items,
                    categories=categories,
                )
            )

    return questions


def apply_membership(variables: list[Variable], questions: list[Question]) -> None:
    """Tag each variable with the question it belongs to (or clear it)."""
    member = {item.column: q.id for q in questions for item in q.items}
    for var in variables:
        var.question_id = member.get(var.name)
