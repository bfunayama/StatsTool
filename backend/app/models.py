"""Data models for datasets and their metadata.

The metadata model is the backbone of StatsTool: variables, their human-friendly
labels, their type, and (for categorical variables) the mapping from stored codes
to readable value labels. Crosstabs, filters, charts and .sav support all build
on top of this.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class VariableType(str, Enum):
    """How a variable should be treated in analysis."""

    categorical = "categorical"
    numeric = "numeric"
    datetime = "datetime"
    text = "text"


class ValueLabel(BaseModel):
    """Maps a stored value (a code) to a human-readable label."""

    value: str
    label: str


class Variable(BaseModel):
    """A single column plus its editable metadata.

    `name` is the original column name and acts as the stable identifier.
    `label` is what the user sees and can rename freely.
    """

    name: str
    label: str
    type: VariableType
    value_labels: list[ValueLabel] = Field(default_factory=list)


class DatasetMeta(BaseModel):
    """Everything we know about an imported dataset except the raw rows."""

    id: str
    source_filename: str
    n_rows: int
    n_cols: int
    variables: list[Variable]


class DatasetSummary(BaseModel):
    """Lightweight dataset entry for listing available datasets."""

    id: str
    source_filename: str
    n_rows: int
    n_cols: int


class VariablesUpdate(BaseModel):
    """Payload for saving edited variable metadata."""

    variables: list[Variable]


class PreviewResponse(BaseModel):
    """A page of raw rows for previewing a dataset."""

    columns: list[str]
    rows: list[dict]
    total_rows: int
