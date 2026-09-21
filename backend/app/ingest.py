"""Reading survey files and inferring variable metadata.

Survey platforms (e.g. Medallia, Qualtrics) often export files that are labelled
`.csv` but are actually UTF-16 encoded and tab-separated. This module detects the
encoding and delimiter instead of assuming plain comma-separated UTF-8.
"""

from __future__ import annotations

import csv
import io

import pandas as pd

from .models import ValueLabel, Variable, VariableType

# A column is treated as categorical only if it has at most this many distinct
# values; above this it is considered free text.
MAX_CATEGORIES = 50

# Share of non-empty values that must parse as a type for it to be inferred.
INFER_THRESHOLD = 0.9


def _detect_encoding(raw: bytes) -> str:
    """Detect text encoding from a byte-order mark, defaulting to UTF-8."""
    if raw.startswith(b"\xff\xfe"):
        return "utf-16"  # little-endian BOM
    if raw.startswith(b"\xfe\xff"):
        return "utf-16"  # big-endian BOM
    if raw.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    return "utf-8"


def _detect_delimiter(sample: str) -> str:
    """Guess the column delimiter from a decoded text sample."""
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
        return dialect.delimiter
    except csv.Error:
        # Fall back to whichever common delimiter appears most in the header.
        header = sample.splitlines()[0] if sample else ""
        counts = {d: header.count(d) for d in ("\t", ",", ";", "|")}
        return max(counts, key=counts.get) or ","


def read_table(raw: bytes) -> pd.DataFrame:
    """Read raw file bytes into a DataFrame, detecting encoding and delimiter."""
    encoding = _detect_encoding(raw)
    text = raw.decode(encoding, errors="replace")
    delimiter = _detect_delimiter(text[:4096])
    # Read every column as string first so type inference is under our control.
    df = pd.read_csv(
        io.StringIO(text),
        sep=delimiter,
        dtype=str,
        keep_default_na=True,
        na_values=[""],
    )
    return _drop_empty_unnamed(df)


def _drop_empty_unnamed(df: pd.DataFrame) -> pd.DataFrame:
    """Drop columns that pandas auto-named (e.g. from a trailing delimiter) and
    that contain no data."""
    to_drop = [
        col
        for col in df.columns
        if str(col).startswith("Unnamed:") and df[col].isna().all()
    ]
    return df.drop(columns=to_drop) if to_drop else df


def _non_empty(series: pd.Series) -> pd.Series:
    return series.dropna().astype(str).str.strip().replace("", pd.NA).dropna()


def _looks_numeric(values: pd.Series) -> bool:
    parsed = pd.to_numeric(values, errors="coerce")
    return parsed.notna().mean() >= INFER_THRESHOLD


def _looks_datetime(values: pd.Series) -> bool:
    # Only attempt when values contain date-like separators, to avoid treating
    # plain numbers as dates.
    if values.str.contains(r"[-/:]").mean() < 0.5:
        return False
    parsed = pd.to_datetime(values, errors="coerce", format="mixed")
    return parsed.notna().mean() >= INFER_THRESHOLD


def infer_variable(name: str, series: pd.Series) -> Variable:
    """Infer a variable's type (and value labels for categoricals) from data."""
    values = _non_empty(series)

    if values.empty:
        return Variable(name=name, label=name, type=VariableType.text)

    if _looks_numeric(values):
        return Variable(name=name, label=name, type=VariableType.numeric)

    if _looks_datetime(values):
        return Variable(name=name, label=name, type=VariableType.datetime)

    distinct = sorted(values.unique())
    if len(distinct) <= MAX_CATEGORIES:
        # Seed value labels as code -> code so the user can rename them later.
        value_labels = [ValueLabel(value=v, label=v) for v in distinct]
        return Variable(
            name=name,
            label=name,
            type=VariableType.categorical,
            value_labels=value_labels,
        )

    return Variable(name=name, label=name, type=VariableType.text)


def infer_variables(df: pd.DataFrame) -> list[Variable]:
    """Infer metadata for every column in the DataFrame."""
    return [infer_variable(str(col), df[col]) for col in df.columns]
