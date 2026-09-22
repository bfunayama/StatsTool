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
    CrosstabRequest,
    CrosstabResponse,
    DatasetMeta,
    Question,
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

    col_var = index.get(request.column)
    if col_var is None:
        raise CrosstabError(f"Unknown column variable: {request.column}")
    col_series = compute.compute_display_series(df, index, col_var)
    col_labels = _ordered_categories(col_series, col_var)

    if request.row.kind == "question":
        question = next((q for q in meta.questions if q.id == request.row.ref), None)
        if question is None:
            raise CrosstabError("Grouped variable not found.")
        if question.kind is not QuestionKind.multi:
            raise CrosstabError(
                "Only Pick any grouped variables are supported as a crosstab row "
                "so far."
            )
        return _crosstab_multi(df, index, col_series, col_labels, question)

    row_var = index.get(request.row.ref)
    if row_var is None:
        raise CrosstabError(f"Unknown row variable: {request.row.ref}")
    return _crosstab_variable(df, index, col_series, col_labels, row_var)


def _crosstab_variable(
    df: pd.DataFrame,
    index: dict[str, Variable],
    col_series: pd.Series,
    col_labels: list[str],
    row_var: Variable,
) -> CrosstabResponse:
    row_series = compute.compute_display_series(df, index, row_var)
    row_labels = _ordered_categories(row_series, row_var)
    row_valid = row_series.notna()

    columns: list[CrosstabColumn] = []
    cells: list[list[CrosstabCell]] = [
        [CrosstabCell(count=0.0) for _ in col_labels] for _ in row_labels
    ]
    for ci, category in enumerate(col_labels):
        in_col = col_series == category
        base = int((in_col & row_valid).sum())
        columns.append(CrosstabColumn(label=category, base=float(base)))
        for ri, label in enumerate(row_labels):
            count = int((in_col & (row_series == label)).sum())
            pct = (count / base * 100.0) if base else None
            cells[ri][ci] = CrosstabCell(count=float(count), column_pct=pct)

    total_base = int((col_series.notna() & row_valid).sum())
    return CrosstabResponse(
        row_labels=row_labels,
        row_values=_row_numeric_values(row_var, row_labels),
        columns=columns,
        cells=cells,
        total_base=float(total_base),
        row_kind="variable",
    )


def _crosstab_multi(
    df: pd.DataFrame,
    index: dict[str, Variable],
    col_series: pd.Series,
    col_labels: list[str],
    question: Question,
) -> CrosstabResponse:
    row_labels = [item.label for item in question.items]
    # Each option is "selected" when its member column has a non-missing value.
    selected: list[pd.Series] = []
    for item in question.items:
        member = index.get(item.column)
        if member is None:
            selected.append(pd.Series(False, index=df.index))
            continue
        member_series = compute.compute_display_series(df, index, member)
        selected.append(member_series.notna())

    answered = selected[0].copy() if selected else pd.Series(False, index=df.index)
    for mask in selected[1:]:
        answered = answered | mask

    columns: list[CrosstabColumn] = []
    cells: list[list[CrosstabCell]] = [
        [CrosstabCell(count=0.0) for _ in col_labels] for _ in row_labels
    ]
    for ci, category in enumerate(col_labels):
        in_col = col_series == category
        base = int((in_col & answered).sum())
        columns.append(CrosstabColumn(label=category, base=float(base)))
        for ri, mask in enumerate(selected):
            count = int((in_col & mask).sum())
            pct = (count / base * 100.0) if base else None
            cells[ri][ci] = CrosstabCell(count=float(count), column_pct=pct)

    total_base = int((col_series.notna() & answered).sum())
    return CrosstabResponse(
        row_labels=row_labels,
        row_values=[None for _ in row_labels],
        columns=columns,
        cells=cells,
        total_base=float(total_base),
        row_kind="multi",
    )
