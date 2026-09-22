"""Compute a crosstab: one row source against one column (banner) variable.

The row can be a single categorical variable or a pick-any grouped variable
(each option becomes a row). Column percentages use a *valid* base — respondents
with a non-missing answer — so missing values never inflate a denominator. Grid
and 2-D grid variables are not supported as a row yet (they are themselves
multi-dimensional, which would make the table 3-D).
"""

from __future__ import annotations

import pandas as pd

from . import compute, filters as filtering
from .models import (
    CrosstabCell,
    CrosstabColumn,
    CrosstabGroup,
    CrosstabRequest,
    CrosstabResponse,
    DatasetMeta,
    QuestionKind,
    Variable,
)


class CrosstabError(ValueError):
    """A crosstab request that cannot be computed (bad variable, unsupported)."""


def _ordered_categories(series: pd.Series, var: Variable) -> list[str]:
    """Distinct non-missing display values, in the variable's preferred order."""
    pairs, _numeric, _vmin, _vmax = compute.distinct_values(series)
    labels = [value for value, _count in pairs]
    order = compute.label_order(var)
    if order is not None:
        rank = {label: i for i, label in enumerate(order)}
        labels.sort(key=lambda label: (rank.get(label, len(order)), label))
    return labels


def _row_numeric_values(var: Variable, labels: list[str]) -> list[float | None]:
    """Numeric value for each row label, for means/sums (None when not numeric).

    Uses the variable's value attributes when present (a label's assigned code);
    otherwise falls back to the label itself if it parses as a number.
    """
    coded = {
        v.label: v.value
        for v in var.values
        if not v.missing and v.value is not None
    }
    values: list[float | None] = []
    for label in labels:
        if label in coded:
            values.append(float(coded[label]))
            continue
        try:
            values.append(float(label))
        except (TypeError, ValueError):
            values.append(None)
    return values


def compute_crosstab(
    df: pd.DataFrame, meta: DatasetMeta, request: CrosstabRequest
) -> CrosstabResponse:
    index = compute.build_index(meta.variables)

    if request.filter_id:
        saved = next((f for f in meta.filters if f.id == request.filter_id), None)
        if saved is None:
            raise CrosstabError("Filter not found.")
        mask = filtering.evaluate_filter(df, index, saved)
        df = df[mask]

    # Banner columns as (label, respondent mask, unused value). Total = one
    # all-true column when there is no column variable.
    if not request.column:
        banner: list[tuple[str, pd.Series, float | None]] = [
            ("Total", pd.Series(True, index=df.index), None)
        ]
    else:
        col_var = index.get(request.column)
        if col_var is None:
            raise CrosstabError(f"Unknown column variable: {request.column}")
        col_series = compute.compute_display_series(df, index, col_var)
        banner = [
            (label, col_series == label, None)
            for label in _ordered_categories(col_series, col_var)
        ]
    banner = _apply_groups(banner, request.column_groups, df.index)

    # Rows as (label, respondent mask, numeric value|None) plus the "valid answer"
    # mask that sets every column's base (grouping never changes the base).
    if request.row.kind == "question":
        question = next((q for q in meta.questions if q.id == request.row.ref), None)
        if question is None:
            raise CrosstabError("Grouped variable not found.")
        if question.kind is not QuestionKind.multi:
            raise CrosstabError(
                "Only Pick any grouped variables are supported as a crosstab row "
                "so far."
            )
        rows: list[tuple[str, pd.Series, float | None]] = []
        row_valid = pd.Series(False, index=df.index)
        for item in question.items:
            member = index.get(item.column)
            selected = (
                compute.compute_display_series(df, index, member).notna()
                if member is not None
                else pd.Series(False, index=df.index)
            )
            rows.append((item.label, selected, None))
            row_valid = row_valid | selected
        row_kind = "multi"
    else:
        row_var = index.get(request.row.ref)
        if row_var is None:
            raise CrosstabError(f"Unknown row variable: {request.row.ref}")
        row_series = compute.compute_display_series(df, index, row_var)
        labels = _ordered_categories(row_series, row_var)
        values = _row_numeric_values(row_var, labels)
        rows = [(lbl, row_series == lbl, val) for lbl, val in zip(labels, values)]
        row_valid = row_series.notna()
        row_kind = "variable"
    rows = _apply_groups(rows, request.row_groups, df.index)

    return _assemble(df.index, banner, rows, row_valid, row_kind)


def _combine(masks: dict[str, pd.Series], members: list[str], index) -> pd.Series:
    """Union of member respondent masks (correct for overlapping pick-any options)."""
    total: pd.Series | None = None
    for member in members:
        mask = masks.get(member)
        if mask is None:
            continue
        total = mask if total is None else (total | mask)
    return total if total is not None else pd.Series(False, index=index)


def _apply_groups(
    items: list[tuple[str, pd.Series, float | None]],
    groups: list[CrosstabGroup],
    index,
) -> list[tuple[str, pd.Series, float | None]]:
    """Apply merges (replace members in place) then append nets (subtotals)."""
    masks = {label: mask for label, mask, _value in items}
    member_to_merge: dict[str, CrosstabGroup] = {}
    for group in (g for g in groups if g.mode == "merge"):
        for member in group.members:
            member_to_merge.setdefault(member, group)

    result: list[tuple[str, pd.Series, float | None]] = []
    emitted: set[str] = set()
    for label, mask, value in items:
        group = member_to_merge.get(label)
        if group is not None:
            if group.id not in emitted:
                emitted.add(group.id)
                result.append((group.label, _combine(masks, group.members, index), None))
            continue
        result.append((label, mask, value))

    for group in (g for g in groups if g.mode == "net"):
        result.append((group.label, _combine(masks, group.members, index), None))
    return result


def _assemble(
    index,
    banner: list[tuple[str, pd.Series, float | None]],
    rows: list[tuple[str, pd.Series, float | None]],
    row_valid: pd.Series,
    row_kind: str,
) -> CrosstabResponse:
    columns: list[CrosstabColumn] = []
    cells: list[list[CrosstabCell]] = [
        [CrosstabCell(count=0.0) for _ in banner] for _ in rows
    ]
    for ci, (label, in_col, _cv) in enumerate(banner):
        base = int((in_col & row_valid).sum())
        columns.append(CrosstabColumn(label=label, base=float(base)))
        for ri, (_rlabel, row_mask, _rv) in enumerate(rows):
            count = int((in_col & row_mask).sum())
            pct = (count / base * 100.0) if base else None
            cells[ri][ci] = CrosstabCell(count=float(count), column_pct=pct)

    union = pd.Series(False, index=index)
    for _label, mask, _value in banner:
        union = union | mask
    total_base = int((union & row_valid).sum())
    return CrosstabResponse(
        row_labels=[label for label, _m, _v in rows],
        row_values=[value for _l, _m, value in rows],
        columns=columns,
        cells=cells,
        total_base=float(total_base),
        row_kind=row_kind,
    )
