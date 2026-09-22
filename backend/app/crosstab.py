"""Compute a crosstab: one row source against one column (banner) variable.

The row can be a single categorical variable or a pick-any grouped variable
(each option becomes a row). Column percentages use a *valid* base — respondents
with a non-missing answer — so missing values never inflate a denominator. Grid
and 2-D grid variables are not supported as a row yet (they are themselves
multi-dimensional, which would make the table 3-D).
"""

from __future__ import annotations

import math

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

    weights = None
    if request.weight:
        weight_var = index.get(request.weight)
        if weight_var is None:
            raise CrosstabError(f"Unknown weight variable: {request.weight}")
        weights = compute.compute_weights(df, index, weight_var)

    return _assemble(df.index, banner, rows, row_valid, row_kind, weights)


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
    weights: pd.Series | None,
) -> CrosstabResponse:
    weighted = weights is not None

    def wsum(mask: pd.Series) -> float:
        return float(weights[mask].sum()) if weighted else float(int(mask.sum()))

    # Effective sample size drives significance variance (actual n when unweighted).
    def n_of(mask: pd.Series) -> float:
        return compute.effective_n(weights[mask]) if weighted else float(int(mask.sum()))

    union = pd.Series(False, index=index)
    for _label, mask, _value in banner:
        union = union | mask
    valid = union & row_valid

    columns: list[CrosstabColumn] = []
    col_valids: list[pd.Series] = []
    col_n: list[float] = []  # sample size for the significance test
    cells: list[list[CrosstabCell]] = [
        [CrosstabCell(count=0.0) for _ in banner] for _ in rows
    ]
    for ci, (label, in_col, _cv) in enumerate(banner):
        col_valid = in_col & row_valid
        base = wsum(col_valid)
        eff = compute.effective_n(weights[col_valid]) if weighted else None
        columns.append(CrosstabColumn(label=label, base=base, eff_base=eff))
        col_valids.append(col_valid)
        col_n.append(n_of(col_valid))
        for ri, (_rlabel, row_mask, _rv) in enumerate(rows):
            count = wsum(in_col & row_mask)
            pct = (count / base * 100.0) if base else None
            cells[ri][ci] = CrosstabCell(count=count, column_pct=pct)

    if len(banner) >= 2:
        _add_significance(banner, rows, cells, columns, col_valids, col_n, valid, wsum, n_of)

    total_base = wsum(valid)
    total_eff = compute.effective_n(weights[valid]) if weighted else None
    return CrosstabResponse(
        row_labels=[label for label, _m, _v in rows],
        row_values=[value for _l, _m, value in rows],
        columns=columns,
        cells=cells,
        total_base=total_base,
        total_eff_base=total_eff,
        weighted=weighted,
        row_kind=row_kind,
    )


_Z_CRIT = 1.959963985  # two-tailed critical value at 95% confidence


def _column_letters(count: int) -> list[str]:
    """Spreadsheet-style column ids: A, B, …, Z, AA, AB, … for ``count`` columns."""
    result: list[str] = []
    for i in range(count):
        label, x = "", i
        while True:
            label = chr(65 + x % 26) + label
            x = x // 26 - 1
            if x < 0:
                break
        result.append(label)
    return result


def _two_prop_z(p1: float, n1: float, p2: float, n2: float) -> float | None:
    """Pooled two-proportion z statistic, or None when it cannot be computed."""
    if n1 <= 0 or n2 <= 0:
        return None
    pooled = (p1 * n1 + p2 * n2) / (n1 + n2)
    var = pooled * (1.0 - pooled) * (1.0 / n1 + 1.0 / n2)
    if var <= 0:
        return None
    return (p1 - p2) / math.sqrt(var)


def _add_significance(
    banner: list[tuple[str, pd.Series, float | None]],
    rows: list[tuple[str, pd.Series, float | None]],
    cells: list[list[CrosstabCell]],
    columns: list[CrosstabColumn],
    col_valids: list[pd.Series],
    col_n: list[float],
    valid: pd.Series,
    wsum,
    n_of,
) -> None:
    """Column-proportion significance at 95%: A/B/C letters and up/down arrows.

    Letters mark the columns a cell is significantly *greater* than. Arrows
    compare each cell to the rest of the sample (▲ higher, ▼ lower).
    """
    for col, letter in zip(columns, _column_letters(len(columns))):
        col.letter = letter

    props = [
        [None if c.column_pct is None else c.column_pct / 100.0 for c in row]
        for row in cells
    ]

    for ri, (_rlabel, row_mask, _rv) in enumerate(rows):
        for ci in range(len(columns)):
            p = props[ri][ci]
            if p is None:
                continue
            rest = valid & ~banner[ci][1]
            base_rest = wsum(rest)
            n_rest = n_of(rest)
            if base_rest <= 0 or n_rest <= 0:
                continue
            p_rest = wsum(row_mask & rest) / base_rest
            z = _two_prop_z(p, col_n[ci], p_rest, n_rest)
            if z is not None and abs(z) >= _Z_CRIT:
                cells[ri][ci].sig_arrow = "up" if z > 0 else "down"

        for j in range(len(columns)):
            pj = props[ri][j]
            if pj is None:
                continue
            beaten: list[str] = []
            for k in range(len(columns)):
                if k == j:
                    continue
                pk = props[ri][k]
                if pk is None or pj <= pk:
                    continue
                z = _two_prop_z(pj, col_n[j], pk, col_n[k])
                if z is not None and z >= _Z_CRIT:
                    letter = columns[k].letter
                    if letter is not None:
                        beaten.append(letter)
            if beaten:
                cells[ri][j].sig_higher = beaten

