"""Evaluate filters into a boolean mask over respondents.

Conditions are tested against each variable's *displayed* values (labels for
categorical/binary/banded variables, raw values for numeric/text), so filters
match what the user sees. Missing values never satisfy a condition.
"""

from __future__ import annotations

from functools import reduce

import pandas as pd

from . import compute
from .models import Condition, Filter, Operator, Variable

_NUMERIC_OPS = {
    Operator.eq,
    Operator.ne,
    Operator.lt,
    Operator.le,
    Operator.gt,
    Operator.ge,
    Operator.between,
}


def evaluate_condition(
    df: pd.DataFrame,
    index: dict[str, Variable],
    condition: Condition,
) -> pd.Series:
    """Return a boolean Series marking rows that satisfy one condition."""
    var = index.get(condition.variable)
    if var is None:
        return pd.Series(False, index=df.index)

    series = compute.compute_display_series(df, index, var)
    op = condition.operator

    if op is Operator.is_missing:
        return series.isna()
    if op is Operator.not_missing:
        return series.notna()

    if op in (Operator.is_in, Operator.not_in):
        text = series.astype("string")
        mask = text.isin(condition.values).fillna(False)
        return mask if op is Operator.is_in else series.notna() & ~mask

    if op in _NUMERIC_OPS:
        numbers = pd.to_numeric(series, errors="coerce")
        if op is Operator.between:
            lo, hi = condition.number, condition.number2
            mask = numbers.notna()
            if lo is not None:
                mask &= numbers >= lo
            if hi is not None:
                mask &= numbers <= hi
            return mask.fillna(False)
        target = condition.number
        if target is None:
            return pd.Series(False, index=df.index)
        comparisons = {
            Operator.eq: numbers == target,
            Operator.ne: numbers != target,
            Operator.lt: numbers < target,
            Operator.le: numbers <= target,
            Operator.gt: numbers > target,
            Operator.ge: numbers >= target,
        }
        return comparisons[op].fillna(False)

    return pd.Series(False, index=df.index)


def evaluate_filter(
    df: pd.DataFrame,
    index: dict[str, Variable],
    filt: Filter,
) -> pd.Series:
    """Return a boolean Series marking rows the filter selects."""
    if not filt.conditions:
        return pd.Series(True, index=df.index)
    masks = [evaluate_condition(df, index, c) for c in filt.conditions]
    combine = (lambda a, b: a & b) if filt.match == "all" else (lambda a, b: a | b)
    return reduce(combine, masks).fillna(False)
