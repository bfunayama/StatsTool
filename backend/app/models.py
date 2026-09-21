"""Data models for datasets and their metadata.

The metadata model is the backbone of StatsTool: variables, their human-friendly
labels, their type, and (Displayr-style) "value attributes" mapping stored values
to a value used in calculations, a label, and an optional Missing flag.

Variables are either:
  * raw       - read straight from an imported column (``source_name is None``)
  * derived   - computed from another column (``source_name`` set), optionally
                transformed by a ``recode`` (banding or binary).
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field


class VariableType(str, Enum):
    """How a variable should be treated in analysis."""

    categorical = "categorical"
    numeric = "numeric"
    datetime = "datetime"
    text = "text"
    binary = "binary"


class ValueAttribute(BaseModel):
    """One stored value plus how it should be treated (Displayr value attributes).

    ``source_value`` is the raw value found in the data (as text). ``value`` is the
    number used in averages/nets. ``label`` is what analysis displays. ``missing``
    excludes the value from analysis.
    """

    source_value: str
    value: float | None = None
    label: str
    missing: bool = False


class Band(BaseModel):
    """An inclusive numeric range mapped to a label (e.g. 18-34 -> 'Young').

    ``min``/``max`` of ``None`` mean open-ended on that side.
    """

    min: float | None = None
    max: float | None = None
    label: str


class BandRecode(BaseModel):
    """Turn a numeric source column into labelled ranges."""

    kind: Literal["band"] = "band"
    bands: list[Band] = Field(default_factory=list)


class BinaryRecode(BaseModel):
    """Turn a column into 1/0 by choosing which values count as True."""

    kind: Literal["binary"] = "binary"
    true_values: list[str] = Field(default_factory=list)
    true_label: str = "Selected"
    false_label: str = "Not selected"


Recode = Annotated[Union[BandRecode, BinaryRecode], Field(discriminator="kind")]


class Variable(BaseModel):
    """A column plus its editable metadata.

    ``name`` is the stable identifier. ``source_name`` links a derived variable to
    the column it is computed from. ``values`` holds value attributes (for
    categorical/binary and value-labelled variables). ``recode`` transforms a
    derived variable (band or binary); when ``None`` a derived variable simply
    maps its source values through ``values``.
    """

    name: str
    label: str
    type: VariableType
    source_name: str | None = None
    values: list[ValueAttribute] = Field(default_factory=list)
    recode: Recode | None = None


class DatasetMeta(BaseModel):
    """Everything we know about an imported dataset except the raw rows."""

    id: str
    source_filename: str
    n_rows: int
    n_cols: int
    variables: list[Variable]
    filters: list["Filter"] = Field(default_factory=list)


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
    """A page of rows for previewing a dataset (values shown as labels)."""

    columns: list[str]
    rows: list[dict]
    total_rows: int


class DistinctValue(BaseModel):
    """A distinct value in a column and how often it occurs."""

    value: str
    count: int


class DistinctResponse(BaseModel):
    """Distinct values of a variable, used to build recode editors."""

    values: list[DistinctValue]
    numeric: bool
    min: float | None = None
    max: float | None = None


class CopyRequest(BaseModel):
    """Duplicate a variable into a new, independently editable one."""

    source_variable: str
    new_label: str | None = None


class BandRequest(BaseModel):
    """Create a banded (ranged) variable from a numeric source."""

    source_variable: str
    new_label: str | None = None
    bands: list[Band]


class BinaryRequest(BaseModel):
    """Create a binary variable by choosing which values count as True."""

    source_variable: str
    new_label: str | None = None
    true_values: list[str]
    true_label: str = "Selected"
    false_label: str = "Not selected"


class Operator(str, Enum):
    """Comparison used by a filter condition."""

    is_in = "in"  # value is one of `values`
    not_in = "not_in"  # value is not one of `values`
    eq = "eq"
    ne = "ne"
    lt = "lt"
    le = "le"
    gt = "gt"
    ge = "ge"
    between = "between"  # number <= x <= number2
    is_missing = "is_missing"
    not_missing = "not_missing"


class Condition(BaseModel):
    """A single test on one variable within a filter."""

    variable: str
    operator: Operator
    values: list[str] = Field(default_factory=list)  # for in / not_in
    number: float | None = None  # for eq..ge, and lower bound of between
    number2: float | None = None  # upper bound of between
    # How this condition joins to the previous one. Ignored on the first
    # condition. None on older saved filters, which fall back to Filter.match.
    connector: Literal["and", "or"] | None = None


class Filter(BaseModel):
    """A named, reusable subset of respondents."""

    id: str
    name: str
    match: Literal["all", "any"] = "all"
    conditions: list[Condition] = Field(default_factory=list)


class FiltersUpdate(BaseModel):
    """Payload for saving the dataset's filters."""

    filters: list[Filter]


class FilterCountResponse(BaseModel):
    """How many respondents a filter selects."""

    count: int
    total: int


# DatasetMeta references Filter before it is defined; resolve the forward ref.
DatasetMeta.model_rebuild()
