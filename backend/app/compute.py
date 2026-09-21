"""Compute derived variables and value mappings on the fly.

Raw variables read straight from the imported columns. Derived variables are
recomputed from their source column every time, so re-importing fresh data keeps
them consistent (and nothing is duplicated on disk).
"""

from __future__ import annotations

import pandas as pd

from .models import (
    Band,
    BandRecode,
    BinaryRecode,
    Variable,
    ValueAttribute,
    VariableType,
)


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

    if var.source_name is None:
        raw = _clean(df[var.name])
    else:
        raw = _source_series(df, index, var.source_name, visited)

    if isinstance(var.recode, BandRecode):
        return _apply_bands(pd.to_numeric(raw, errors="coerce"), var.recode.bands)
    if isinstance(var.recode, BinaryRecode):
        return _apply_binary(raw, var.recode)
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
