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

    # Correlation mode: Pearson r between two numeric operands (each a single
    # numeric variable or a grid question's items), using a pairwise base.
    if request.correlation:
        return _correlation_response(df, index, meta, request)

    # A grid question on the row axis is its own 2-D table (items × shared scale);
    # the scale occupies the column axis, so the banner/column is ignored.
    if request.row.kind == "question":
        grid_q = next((q for q in meta.questions if q.id == request.row.ref), None)
        if grid_q is not None and grid_q.kind is QuestionKind.grid:
            weights = None
            if request.weight:
                wv = index.get(request.weight)
                if wv is None:
                    raise CrosstabError(f"Unknown weight variable: {request.weight}")
                weights = compute.compute_weights(df, index, wv)
            return _grid_response(df, index, grid_q, weights)

    # Banner columns (side-by-side segments, optionally two levels deep).
    banner, col_top, col_group, col_seg, col_full_base = _build_banner(
        df, index, request, meta.questions
    )

    # Rows as (label, respondent mask, numeric value|None) plus the "valid answer"
    # mask that sets every column's base (grouping never changes the base).
    if request.row.kind == "total":
        rows: list[tuple[str, pd.Series, float | None]] = [
            ("Total", pd.Series(True, index=df.index), None)
        ]
        row_valid = pd.Series(True, index=df.index)
        row_kind = "variable"
    elif request.row.kind == "question":
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

    return _assemble(
        df.index,
        banner,
        col_top,
        col_group,
        col_seg,
        col_full_base,
        rows,
        row_valid,
        row_kind,
        weights,
    )


def _grid_response(
    df: pd.DataFrame, index, question, weights: pd.Series | None
) -> CrosstabResponse:
    """A grid question as a 2-D table: rows = items, columns = the shared scale.

    Cell[item][scale] counts respondents who gave that scale answer for the item;
    Row % (count / item base) is the natural reading. A per-item mean is available
    as a summary column when the scale is numeric.
    """
    idx = df.index
    weighted = weights is not None

    def wsum(mask: pd.Series) -> float:
        return float(weights[mask].sum()) if weighted else float(int(mask.sum()))

    scale = list(question.categories)
    first_member = index.get(question.items[0].column) if question.items else None
    col_values = (
        _row_numeric_values(first_member, scale)
        if first_member is not None
        else [None] * len(scale)
    )

    cells: list[list[CrosstabCell]] = []
    row_base: list[float] = []
    row_eff_base: list[float | None] = []
    row_count: list[float] = []
    answered_any = pd.Series(False, index=idx)
    for item in question.items:
        member = index.get(item.column)
        series = (
            compute.compute_display_series(df, index, member)
            if member is not None
            else pd.Series(pd.NA, index=idx)
        )
        answered = series.notna()
        answered_any = answered_any | answered
        cells.append([CrosstabCell(count=wsum(series == cat)) for cat in scale])
        row_base.append(wsum(answered))
        row_count.append(float(int(answered.sum())))
        row_eff_base.append(
            compute.effective_n(weights[answered]) if weighted else None
        )

    total_base = wsum(answered_any)
    total_eff = compute.effective_n(weights[answered_any]) if weighted else None
    # Scale columns share the grid base; Row % is the natural per-item reading.
    columns = [
        CrosstabColumn(
            label=cat,
            base=total_base,
            eff_base=total_eff,
            top_label="",
            group="__all__",
            seg=-1,
        )
        for cat in scale
    ]
    return CrosstabResponse(
        row_labels=[it.label for it in question.items],
        row_values=[None] * len(question.items),
        columns=columns,
        cells=cells,
        total_base=total_base,
        total_eff_base=total_eff,
        weighted=weighted,
        row_kind="grid",
        row_base=row_base,
        row_eff_base=row_eff_base,
        row_count=row_count,
        col_values=col_values,
    )


def _grid_numeric_series(
    df: pd.DataFrame, index, question
) -> tuple[list[pd.Series], list[str]]:
    """Each grid item as a numeric series (scale label → code), plus its label."""
    vals = None
    if question.items:
        first = index.get(question.items[0].column)
        vals = _row_numeric_values(first, question.categories) if first else None
    mapping = (
        {cat: v for cat, v in zip(question.categories, vals) if v is not None}
        if vals
        else {}
    )
    series: list[pd.Series] = []
    labels: list[str] = []
    for item in question.items:
        member = index.get(item.column)
        if member is None:
            series.append(pd.Series(float("nan"), index=df.index))
        else:
            s = compute.compute_display_series(df, index, member)
            num = s.map(mapping) if mapping else s
            series.append(pd.to_numeric(num, errors="coerce"))
        labels.append(item.label)
    return series, labels


def _variable_numeric_series(df: pd.DataFrame, index, var: Variable) -> pd.Series:
    """A single variable's display values as numbers (value codes, else parsed)."""
    coded = {
        v.label: v.value
        for v in var.values
        if not v.missing and v.value is not None
    }
    s = compute.compute_display_series(df, index, var)
    num = s.map(coded) if coded else s
    return pd.to_numeric(num, errors="coerce")


def _corr_operand(
    df: pd.DataFrame, index, meta: DatasetMeta, kind: str, ref: str
) -> tuple[list[pd.Series], list[str]]:
    """Resolve one side of a correlation into numeric series + their labels."""
    if kind == "question":
        q = next((x for x in meta.questions if x.id == ref), None)
        if q is None or q.kind is not QuestionKind.grid:
            raise CrosstabError("Correlation needs a numeric grid question.")
        return _grid_numeric_series(df, index, q)
    var = index.get(ref)
    if var is None:
        raise CrosstabError(f"Correlation variable not found: {ref}")
    return [_variable_numeric_series(df, index, var)], [var.label]


def _resolve_corr_target(meta: DatasetMeta, request: CrosstabRequest) -> tuple[str, str]:
    """Pick the column operand: an explicit corr_with, else a grid's self-matrix."""
    target = request.corr_with
    if not target:
        if request.row.kind == "question":
            return "question", request.row.ref
        raise CrosstabError("Choose a column variable to correlate with.")
    if any(q.id == target for q in meta.questions):
        return "question", target
    if any(v.name == target for v in meta.variables):
        return "variable", target
    raise CrosstabError("Correlation target not found.")


def _pearson(x, y, w=None) -> float | None:
    """Pearson correlation of two aligned arrays, optionally weighted.

    Returns None when undefined (fewer than two points, or a flat series).
    """
    import numpy as np

    if len(x) < 2:
        return None
    if w is None:
        xd = x - x.mean()
        yd = y - y.mean()
        denom = float(np.sqrt(float((xd * xd).sum()) * float((yd * yd).sum())))
        if denom == 0.0:
            return None
        return float((xd * yd).sum() / denom)
    sw = float(w.sum())
    if sw <= 0.0:
        return None
    mx = float((w * x).sum() / sw)
    my = float((w * y).sum() / sw)
    xd = x - mx
    yd = y - my
    denom = float(np.sqrt(float((w * xd * xd).sum()) * float((w * yd * yd).sum())))
    if denom == 0.0:
        return None
    return float((w * xd * yd).sum() / denom)


def _corr_significant(r: float | None, n: int) -> bool:
    """Whether a Pearson r differs from 0 at 95% (two-tailed t-test, df = n-2)."""
    if r is None or n < 3:
        return False
    if abs(r) >= 1.0:
        return True
    t = abs(r) * math.sqrt((n - 2) / (1.0 - r * r))
    return t > 1.96  # ~95% two-tailed critical value for survey-sized n


def _correlation_response(
    df: pd.DataFrame, index, meta: DatasetMeta, request: CrosstabRequest
) -> CrosstabResponse:
    """Pearson r matrix between two numeric operands (grid items or variables).

    Each operand is a grid question (its items) or a single numeric variable.
    Weighted when a weight variable is supplied. r is None where fewer than two
    respondents answered both series or a series has no variance. Significance is
    a two-tailed t-test that r differs from 0 at 95% (the trivial self-diagonal
    is left unflagged).
    """
    row_series, row_labels = _corr_operand(
        df, index, meta, request.row.kind, request.row.ref
    )
    col_kind, col_ref = _resolve_corr_target(meta, request)
    col_series, col_labels = _corr_operand(df, index, meta, col_kind, col_ref)
    # Self-matrix: same operand on both axes, so its diagonal is a trivial r = 1.
    is_self = col_kind == request.row.kind and col_ref == request.row.ref

    weights = None
    if request.weight:
        wv = index.get(request.weight)
        if wv is None:
            raise CrosstabError(f"Unknown weight variable: {request.weight}")
        weights = compute.compute_weights(df, index, wv)

    cells: list[list[CrosstabCell]] = []
    for i, rs in enumerate(row_series):
        row_cells: list[CrosstabCell] = []
        for j, cs in enumerate(col_series):
            both = rs.notna() & cs.notna()
            n = int(both.sum())
            w = weights[both].to_numpy(float) if weights is not None else None
            r = (
                _pearson(rs[both].to_numpy(float), cs[both].to_numpy(float), w)
                if n >= 2
                else None
            )
            diagonal = is_self and i == j
            sig = False if diagonal else _corr_significant(r, n)
            row_cells.append(CrosstabCell(count=float(n), corr=r, corr_sig=sig))
        cells.append(row_cells)

    columns = [
        CrosstabColumn(
            label=lbl,
            base=float(int(cs.notna().sum())),
            top_label="",
            group="__all__",
            seg=-1,
        )
        for lbl, cs in zip(col_labels, col_series)
    ]
    row_base = [float(int(rs.notna().sum())) for rs in row_series]
    return CrosstabResponse(
        row_labels=row_labels,
        row_values=[None] * len(row_labels),
        columns=columns,
        cells=cells,
        total_base=float(len(df)),
        total_eff_base=None,
        weighted=weights is not None,
        row_kind="variable",
        row_base=row_base,
        row_eff_base=[None] * len(row_labels),
        row_count=row_base,
        col_values=[None] * len(col_labels),
    )


# One banner column while building: (label, respondent mask, unused value).
_GROUP_SEP = "\u0001"


def _build_banner(
    df: pd.DataFrame, index, request: CrosstabRequest, questions
) -> tuple[
    list[tuple[str, pd.Series, float | None]],
    list[str],
    list[str],
    list[int],
    list[bool],
]:
    """Build banner columns plus per-column top label, sig group, segment, and a
    "whole-sample base" flag (True for pick-any question columns).

    ``request.banner`` (new) supports side-by-side segments and two-level nesting;
    otherwise fall back to the single ``column`` (with column NET/merge groups).
    """
    idx = df.index
    if request.banner:
        banner: list[tuple[str, pd.Series, float | None]] = []
        top: list[str] = []
        group: list[str] = []
        seg_of: list[int] = []
        full_base: list[bool] = []
        for si, segment in enumerate(request.banner):
            # NET/merge groups defined on this segment's leaf categories.
            seg_groups = [
                CrosstabGroup(id=g.id, label=g.label, members=g.members, mode=g.mode)
                for g in request.banner_groups
                if g.seg == si
            ]
            if segment.question:  # pick-any question → its options become columns
                q = next((qq for qq in questions if qq.id == segment.question), None)
                if q is None:
                    raise CrosstabError("Banner grouped variable not found.")
                if q.kind is not QuestionKind.multi:
                    raise CrosstabError(
                        "Only Pick any grouped variables are supported on the "
                        "column axis so far."
                    )
                items = []
                for item in q.items:
                    member = index.get(item.column)
                    selected = (
                        compute.compute_display_series(df, index, member).notna()
                        if member is not None
                        else pd.Series(False, index=idx)
                    )
                    items.append((item.label, selected, None))
                for label, mask, _v in _apply_groups(items, seg_groups, idx):
                    banner.append((label, mask, None))
                    top.append(q.label)
                    group.append(f"{si}{_GROUP_SEP}__var__")
                    seg_of.append(si)
                    full_base.append(True)
                continue
            variables = segment.variables
            if not variables:  # Total column
                banner.append(("Total", pd.Series(True, index=idx), None))
                top.append("Total")
                group.append(f"{si}{_GROUP_SEP}__total__")
                seg_of.append(si)
                full_base.append(False)
                continue
            primary = index.get(variables[0])
            if primary is None:
                raise CrosstabError(f"Unknown banner variable: {variables[0]}")
            s1 = compute.compute_display_series(df, index, primary)
            if len(variables) == 1:
                labels1 = _ordered_categories(s1, primary)
                vals1 = _row_numeric_values(primary, labels1)
                items = [(lbl, s1 == lbl, v) for lbl, v in zip(labels1, vals1)]
                for label, mask, cv in _apply_groups(items, seg_groups, idx):
                    banner.append((label, mask, cv))
                    top.append(primary.label)
                    group.append(f"{si}{_GROUP_SEP}__var__")
                    seg_of.append(si)
                    full_base.append(False)
                continue
            nested = index.get(variables[1])
            if nested is None:
                raise CrosstabError(f"Unknown banner variable: {variables[1]}")
            s2 = compute.compute_display_series(df, index, nested)
            sub_labels = _ordered_categories(s2, nested)
            for c1 in _ordered_categories(s1, primary):
                m1 = s1 == c1
                items = [(c2, m1 & (s2 == c2), None) for c2 in sub_labels]
                for label, mask, _v in _apply_groups(items, seg_groups, idx):
                    banner.append((label, mask, None))
                    top.append(c1)
                    group.append(f"{si}{_GROUP_SEP}{c1}")
                    seg_of.append(si)
                    full_base.append(False)
        return banner, top, group, seg_of, full_base

    # Legacy single-column path (Total or one variable), with column NET/merge.
    if not request.column:
        banner = [("Total", pd.Series(True, index=idx), None)]
    else:
        col_var = index.get(request.column)
        if col_var is None:
            raise CrosstabError(f"Unknown column variable: {request.column}")
        col_series = compute.compute_display_series(df, index, col_var)
        labels = _ordered_categories(col_series, col_var)
        vals = _row_numeric_values(col_var, labels)
        banner = [
            (label, col_series == label, v) for label, v in zip(labels, vals)
        ]
    banner = _apply_groups(banner, request.column_groups, idx)
    # Flat header (no top row) and a single comparison group across all columns.
    n = len(banner)
    return banner, [""] * n, ["__all__"] * n, [-1] * n, [False] * n



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
    col_top: list[str],
    col_group: list[str],
    col_seg: list[int],
    col_full_base: list[bool],
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

    # A column's base mask: its own respondents, or the whole valid sample for
    # pick-any (full-base) columns. ``valid`` (table base) unions these.
    col_base_masks = [
        (row_valid if col_full_base[ci] else (mask & row_valid))
        for ci, (_label, mask, _value) in enumerate(banner)
    ]
    valid = pd.Series(False, index=index)
    for bm in col_base_masks:
        valid = valid | bm

    columns: list[CrosstabColumn] = []
    col_valids: list[pd.Series] = []
    col_n: list[float] = []  # sample size for the significance test
    cells: list[list[CrosstabCell]] = [
        [CrosstabCell(count=0.0) for _ in banner] for _ in rows
    ]
    for ci, (label, in_col, _cv) in enumerate(banner):
        col_valid = col_base_masks[ci]
        base = wsum(col_valid)
        eff = compute.effective_n(weights[col_valid]) if weighted else None
        columns.append(
            CrosstabColumn(
                label=label,
                base=base,
                eff_base=eff,
                top_label=col_top[ci],
                group=col_group[ci],
                seg=col_seg[ci],
            )
        )
        col_valids.append(col_valid)
        col_n.append(n_of(col_valid))
        for ri, (_rlabel, row_mask, _rv) in enumerate(rows):
            count = wsum(in_col & row_mask)
            pct = (count / base * 100.0) if base else None
            cells[ri][ci] = CrosstabCell(count=count, column_pct=pct)

    if len(banner) >= 2:
        _add_significance(
            rows, cells, columns, col_valids, col_n, col_group, wsum, n_of
        )

    # Per-row summaries (shown as summary columns): true unweighted n, weighted
    # base, and effective n. Column numeric values drive row Sum/Mean.
    row_base: list[float] = []
    row_eff_base: list[float | None] = []
    row_count: list[float] = []
    for _rlabel, row_mask, _rv in rows:
        rm = valid & row_mask
        row_count.append(float(int(rm.sum())))
        row_base.append(wsum(rm))
        row_eff_base.append(compute.effective_n(weights[rm]) if weighted else None)
    col_values = [cv for _l, _m, cv in banner]

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
        row_base=row_base,
        row_eff_base=row_eff_base,
        row_count=row_count,
        col_values=col_values,
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
    rows: list[tuple[str, pd.Series, float | None]],
    cells: list[list[CrosstabCell]],
    columns: list[CrosstabColumn],
    col_valids: list[pd.Series],
    col_n: list[float],
    col_group: list[str],
    wsum,
    n_of,
) -> None:
    """Column-proportion significance at 95%: A/B/C letters and up/down arrows.

    Comparisons are made *within* each banner sub-group (columns sharing a parent
    header). Letters mark the columns a cell is significantly greater than; arrows
    compare each cell to the rest of its sub-group (▲ higher, ▼ lower).
    """
    for col, letter in zip(columns, _column_letters(len(columns))):
        col.letter = letter

    # Column indices grouped by their significance sub-group, in display order.
    groups: dict[str, list[int]] = {}
    for ci, gid in enumerate(col_group):
        groups.setdefault(gid, []).append(ci)

    props = [
        [None if c.column_pct is None else c.column_pct / 100.0 for c in row]
        for row in cells
    ]

    for ri, (_rlabel, row_mask, _rv) in enumerate(rows):
        for members in groups.values():
            if len(members) < 2:
                continue
            for ci in members:
                p = props[ri][ci]
                if p is None:
                    continue
                # "Rest" = the other columns in this same sub-group.
                rest = pd.Series(False, index=row_mask.index)
                for other in members:
                    if other != ci:
                        rest = rest | col_valids[other]
                base_rest = wsum(rest)
                n_rest = n_of(rest)
                if base_rest > 0 and n_rest > 0:
                    p_rest = wsum(row_mask & rest) / base_rest
                    z = _two_prop_z(p, col_n[ci], p_rest, n_rest)
                    if z is not None and abs(z) >= _Z_CRIT:
                        cells[ri][ci].sig_arrow = "up" if z > 0 else "down"

                beaten: list[str] = []
                for other in members:
                    if other == ci:
                        continue
                    po = props[ri][other]
                    if po is None or p <= po:
                        continue
                    z = _two_prop_z(p, col_n[ci], po, col_n[other])
                    if z is not None and z >= _Z_CRIT:
                        letter = columns[other].letter
                        if letter is not None:
                            beaten.append(letter)
                if beaten:
                    cells[ri][ci].sig_higher = beaten

