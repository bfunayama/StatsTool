"""Compute derived variables and value mappings on the fly.

Raw variables read straight from the imported columns. Derived variables are
recomputed from their source column every time, so re-importing fresh data keeps
them consistent (and nothing is duplicated on disk).
"""

from __future__ import annotations

import uuid

import pandas as pd

from .models import (
    Band,
    BandRecode,
    BinaryRecode,
    CoalesceRecode,
    CompactSelectRecode,
    Question,
    QuestionItem,
    QuestionKind,
    Variable,
    ValueAttribute,
    VariableType,
)

# Separators Askable (and similar tools) use to pack several picks into one cell.
_COMPACT_DELIMITERS = ("|", ";")


def build_index(variables: list[Variable]) -> dict[str, Variable]:
    return {v.name: v for v in variables}


def _clean(series: pd.Series) -> pd.Series:
    """Return values as trimmed strings with blanks as NA."""
    s = series.astype("string").str.strip()
    return s.replace("", pd.NA)


def distinct_values(series: pd.Series) -> tuple[list[tuple[str, int]], bool, float | None, float | None]:
    """Distinct non-missing values with counts; plus numeric range if numeric."""
    values = _clean(series).dropna()
    counts = values.value_counts()
    pairs = [(str(v), int(c)) for v, c in counts.items()]
    numeric_parsed = pd.to_numeric(values, errors="coerce")
    is_numeric = bool(len(values)) and numeric_parsed.notna().mean() >= 0.9
    vmin = float(numeric_parsed.min()) if is_numeric and numeric_parsed.notna().any() else None
    vmax = float(numeric_parsed.max()) if is_numeric and numeric_parsed.notna().any() else None
    pairs.sort(key=lambda p: p[0])
    return pairs, is_numeric, vmin, vmax


def label_order(var: Variable) -> list[str] | None:
    """Preferred display-label order for a variable, or None for default sort.

    Categorical labels follow their value attributes (ordered by the assigned
    numeric value); banded/binary labels follow the recode's own order.
    """
    if isinstance(var.recode, BandRecode):
        return [b.label for b in var.recode.bands]
    if isinstance(var.recode, BinaryRecode):
        return [var.recode.false_label, var.recode.true_label]
    if isinstance(var.recode, CompactSelectRecode):
        return [var.recode.value]
    if isinstance(var.recode, CoalesceRecode):
        labels = [v.label for v in var.values if not v.missing]
        return labels or None
    if var.values:
        ordered = sorted(
            (v for v in var.values if not v.missing),
            key=lambda v: v.value if v.value is not None else float("inf"),
        )
        labels: list[str] = []
        for v in ordered:
            if v.label not in labels:
                labels.append(v.label)
        return labels
    return None


def seed_value_attributes(series: pd.Series) -> list[ValueAttribute]:
    """Build starter value attributes from a column's distinct values.

    Numeric-looking values keep their number; text values get sequential codes.
    """
    pairs, is_numeric, _, _ = distinct_values(series)
    attributes: list[ValueAttribute] = []
    for index, (raw, _count) in enumerate(pairs, start=1):
        if is_numeric:
            try:
                value: float | None = float(raw)
            except ValueError:
                value = float(index)
        else:
            value = float(index)
        attributes.append(ValueAttribute(source_value=raw, value=value, label=raw))
    return attributes


def _source_series(
    df: pd.DataFrame,
    index: dict[str, Variable],
    source_name: str,
    visited: set[str],
) -> pd.Series:
    """Underlying values to feed a derived variable's recode/mapping."""
    var = index.get(source_name)
    if var is None:
        if source_name in df.columns:
            return _clean(df[source_name])
        raise ValueError(f"Unknown source variable: {source_name}")
    if var.source_name is None and var.recode is None:
        return _clean(df[var.name])
    return _clean(compute_display_series(df, index, var, visited))


def compute_display_series(
    df: pd.DataFrame,
    index: dict[str, Variable],
    var: Variable,
    visited: set[str] | None = None,
) -> pd.Series:
    """Return the values to display/analyse for a variable (labels applied)."""
    visited = visited or set()
    if var.name in visited:
        raise ValueError(f"Circular variable reference at {var.name}")
    visited = visited | {var.name}

    if var.type == VariableType.weight:
        return compute_weights(df, index, var)

    if isinstance(var.recode, CoalesceRecode):
        return _apply_coalesce(df, index, var.recode, visited)

    if var.source_name is None:
        raw = _clean(df[var.name])
    else:
        raw = _source_series(df, index, var.source_name, visited)

    if isinstance(var.recode, BandRecode):
        return _apply_bands(pd.to_numeric(raw, errors="coerce"), var.recode.bands)
    if isinstance(var.recode, BinaryRecode):
        return _apply_binary(raw, var.recode)
    if isinstance(var.recode, CompactSelectRecode):
        return _apply_compact_select(raw, var.recode)
    return _apply_values(raw, var.values)


def _apply_values(raw: pd.Series, values: list[ValueAttribute]) -> pd.Series:
    """Map raw values to labels; unmapped values pass through, missing -> NA."""
    if not values:
        return raw
    label_map = {v.source_value: (pd.NA if v.missing else v.label) for v in values}

    def convert(value):
        if pd.isna(value):
            return pd.NA
        return label_map.get(value, value)

    return raw.map(convert).astype("object")


def _apply_bands(numbers: pd.Series, bands: list[Band]) -> pd.Series:
    def convert(x):
        if pd.isna(x):
            return pd.NA
        for band in bands:
            if (band.min is None or x >= band.min) and (band.max is None or x <= band.max):
                return band.label
        return pd.NA

    return numbers.map(convert).astype("object")


def _apply_binary(raw: pd.Series, recode: BinaryRecode) -> pd.Series:
    true_set = set(recode.true_values)

    def convert(value):
        if pd.isna(value):
            return pd.NA
        return recode.true_label if value in true_set else recode.false_label

    return raw.map(convert).astype("object")


def _split_compact(cell, delimiter: str) -> list[str]:
    """Split one compact cell into its trimmed, non-empty option labels."""
    if cell is None or pd.isna(cell):
        return []
    return [p.strip() for p in str(cell).split(delimiter) if p.strip()]


def _apply_compact_select(raw: pd.Series, recode: CompactSelectRecode) -> pd.Series:
    """One pick-any member: the option label when selected, else missing."""

    def convert(cell):
        parts = _split_compact(cell, recode.delimiter)
        if not parts:
            return pd.NA
        return recode.value if recode.value in parts else pd.NA

    return raw.map(convert).astype("object")


def _coalesce_series(
    df: pd.DataFrame,
    index: dict[str, Variable],
    sources: list[str],
    visited: set[str],
) -> list[pd.Series]:
    """Display series for each coalesce source (resolving derived sources)."""
    out: list[pd.Series] = []
    for name in sources:
        var = index.get(name)
        if var is None:
            if name in df.columns:
                out.append(_clean(df[name]))
                continue
            raise ValueError(f"Unknown source variable: {name}")
        out.append(_clean(compute_display_series(df, index, var, visited)))
    return out


def _apply_coalesce(
    df: pd.DataFrame,
    index: dict[str, Variable],
    recode: CoalesceRecode,
    visited: set[str],
) -> pd.Series:
    """First non-missing value across the source columns, row by row."""
    series = _coalesce_series(df, index, recode.sources, visited)
    if not series:
        return pd.Series([pd.NA] * len(df), index=df.index, dtype="object")
    result = series[0].copy()
    for s in series[1:]:
        result = result.where(result.notna(), s)
    return result.astype("object")


def coalesce_value_attributes(
    df: pd.DataFrame, index: dict[str, Variable], sources: list[str]
) -> list[ValueAttribute]:
    """Union of the source value labels, first-seen order, sequential codes."""
    series = _coalesce_series(df, index, sources, set())
    seen: list[str] = []
    for s in series:
        for label in s.dropna().astype(str):
            if label not in seen:
                seen.append(label)
    return [
        ValueAttribute(source_value=label, value=float(i + 1), label=label)
        for i, label in enumerate(seen)
    ]


def detect_compact_delimiter(series: pd.Series) -> str | None:
    """Return the separator that packs multiple picks into one cell, or None.

    A delimiter qualifies only if at least one cell splits into two or more
    non-empty parts (a lone answer label never contains the separator).
    """
    s = series.dropna().astype(str)
    if s.empty:
        return None
    for delimiter in _COMPACT_DELIMITERS:
        if s.map(lambda cell, d=delimiter: len(_split_compact(cell, d)) > 1).any():
            return delimiter
    return None


def compact_options(series: pd.Series, delimiter: str) -> list[tuple[str, int]]:
    """Distinct options across a compact column, ordered by count then label."""
    counts: dict[str, int] = {}
    for cell in series:
        for opt in _split_compact(cell, delimiter):
            counts[opt] = counts.get(opt, 0) + 1
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


def build_comparison_grid(
    sources: list[str],
    item_labels: list[str],
    name: str,
    categories: list[str],
) -> Question:
    """A side-by-side comparison grid: one item per source, sharing one scale."""
    return Question(
        id=uuid.uuid4().hex,
        name=name,
        label=name,
        kind=QuestionKind.grid,
        items=[
            QuestionItem(column=src, label=label)
            for src, label in zip(sources, item_labels)
        ],
        categories=categories,
    )


def build_compact_pickany(
    source_name: str,
    source_label: str,
    options: list[str],
    delimiter: str,
    existing: set[str],
) -> tuple[list[Variable], Question]:
    """Derived member variables + a pick-any question for a compact column."""
    qid = uuid.uuid4().hex
    members: list[Variable] = []
    items: list[QuestionItem] = []
    for opt in options:
        name = unique_name(f"{source_label}: {opt}", existing)
        existing.add(name)
        members.append(
            Variable(
                name=name,
                label=opt,
                type=VariableType.categorical,
                source_name=source_name,
                values=[ValueAttribute(source_value=opt, value=1.0, label=opt)],
                recode=CompactSelectRecode(value=opt, delimiter=delimiter),
                question_id=qid,
            )
        )
        items.append(QuestionItem(column=name, label=opt))
    question = Question(
        id=qid,
        name=source_label,
        label=source_label,
        kind=QuestionKind.multi,
        items=items,
    )
    return members, question


def band_value_attributes(bands: list[Band]) -> list[ValueAttribute]:
    return [
        ValueAttribute(source_value=b.label, value=float(i + 1), label=b.label)
        for i, b in enumerate(bands)
    ]


def binary_value_attributes(recode: BinaryRecode) -> list[ValueAttribute]:
    return [
        ValueAttribute(source_value=recode.false_label, value=0.0, label=recode.false_label),
        ValueAttribute(source_value=recode.true_label, value=1.0, label=recode.true_label),
    ]


def unique_name(base: str, existing: set[str]) -> str:
    """Pick a variable name not already taken (base, base_2, base_3, ...)."""
    if base not in existing:
        return base
    n = 2
    while f"{base}_{n}" in existing:
        n += 1
    return f"{base}_{n}"


def default_derived_type(source_type: VariableType) -> VariableType:
    return source_type


def effective_n(weights: pd.Series) -> float:
    """Kish effective sample size: (Σw)² / Σw². Equals n when weights are equal."""
    s1 = float(weights.sum())
    s2 = float((weights**2).sum())
    return (s1 * s1 / s2) if s2 > 0 else 0.0


def _weight_series(df: pd.DataFrame, index: dict[str, Variable], name: str) -> pd.Series:
    var = index.get(name)
    series = (
        compute_display_series(df, index, var)
        if var is not None
        else _clean(df[name])
    )
    return series.astype("string")


def combinations(
    df: pd.DataFrame,
    index: dict[str, Variable],
    variables: list[str],
    include_missing: bool,
) -> list[tuple[list[str], int]]:
    """Observed category combinations across ``variables`` (for weight targets)."""
    cols: list[pd.Series] = []
    ranks: list[dict[str, int]] = []
    for name in variables:
        series = _weight_series(df, index, name)
        if include_missing:
            series = series.fillna("(Missing)")
        cols.append(series)
        order = label_order(index[name]) if name in index else None
        ranks.append({label: i for i, label in enumerate(order)} if order else {})

    frame = pd.concat(cols, axis=1)
    frame.columns = [f"v{i}" for i in range(len(cols))]
    if not include_missing:
        frame = frame.dropna()
    grouped = (
        frame.groupby(list(frame.columns), dropna=False).size().reset_index(name="n")
    )

    rows: list[tuple[list[str], int]] = []
    for _, row in grouped.iterrows():
        values = [str(row[c]) for c in frame.columns]
        rows.append((values, int(row["n"])))
    rows.sort(
        key=lambda item: tuple(
            ranks[i].get(item[0][i], len(ranks[i])) for i in range(len(variables))
        )
        + tuple(item[0])
    )
    return rows


def compute_weights(
    df: pd.DataFrame,
    index: dict[str, Variable],
    weight_var: Variable,
) -> pd.Series:
    """Per-respondent rim/rake weights via iterative proportional fitting (IPF).

    Weights are normalised so their mean is 1 (their sum equals the included
    sample size). Respondents excluded by a rim's missing rule get weight 0.
    Target percentages are normalised to sum to 1 within each rim, and sample
    cells with no respondents are skipped (they cannot be weighted up to).
    """
    spec = weight_var.weighting
    if spec is None or not spec.rims:
        return pd.Series(1.0, index=df.index)

    used = {v for rim in spec.rims for v in rim.variables}
    series = {name: _weight_series(df, index, name) for name in used}

    included = pd.Series(True, index=df.index)
    for rim in spec.rims:
        if rim.missing == "exclude":
            for v in rim.variables:
                included &= series[v].notna()
    for rim in spec.rims:
        if rim.missing == "category":
            for v in rim.variables:
                series[v] = series[v].fillna("(Missing)")

    weights = pd.Series(0.0, index=df.index)
    weights[included] = 1.0

    # Precompute each rim's cell masks + normalised targets (skip empty cells).
    rim_cells: list[list[tuple[pd.Series, float]]] = []
    for rim in spec.rims:
        total_pct = sum(c.percent for c in rim.cells) or 1.0
        cells: list[tuple[pd.Series, float]] = []
        for cell in rim.cells:
            mask = included.copy()
            for var_name, value in zip(rim.variables, cell.values):
                mask &= series[var_name] == value
            if bool(mask.any()):
                cells.append((mask, cell.percent / total_pct))
        rim_cells.append(cells)

    for _ in range(max(1, spec.max_iter)):
        max_dev = 0.0
        for cells in rim_cells:
            total = float(weights[included].sum())
            if total <= 0:
                continue
            for mask, target_prop in cells:
                current = float(weights[mask].sum())
                if current <= 0:
                    continue
                cur_prop = current / total
                max_dev = max(max_dev, abs(target_prop - cur_prop))
                weights.loc[mask] *= target_prop / cur_prop
                total = float(weights[included].sum())
        if max_dev < 1e-8:
            break

    total = float(weights[included].sum())
    n = int(included.sum())
    if total > 0:
        weights.loc[included] *= n / total
    return weights

