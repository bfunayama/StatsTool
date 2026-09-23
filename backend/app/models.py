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
    weight = "weight"  # a computed rim/rake weight (see WeightSpec)


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


class WeightCell(BaseModel):
    """One target proportion within a rim.

    ``values`` holds one display label per variable in the rim (length 1 for a
    marginal rim, longer for an interlocked rim). ``percent`` is the target share.
    """

    values: list[str]
    percent: float


class WeightRim(BaseModel):
    """A control the weights must match: a variable (marginal) or several
    variables crossed (interlocked). ``missing`` chooses how blanks are treated.
    """

    id: str
    variables: list[str]
    missing: Literal["exclude", "category"] = "exclude"
    cells: list[WeightCell] = Field(default_factory=list)


class WeightSpec(BaseModel):
    """Definition of a rim/rake weight: target proportions raked via IPF."""

    rims: list[WeightRim] = Field(default_factory=list)
    max_iter: int = 50


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
    # Set when this column belongs to a detected matrix/grid question.
    question_id: str | None = None
    # Set only for type == weight: how the rake weight is defined.
    weighting: WeightSpec | None = None


class QuestionKind(str, Enum):
    """Shape of a matrix/grid question."""

    multi = "multi"  # pick-any: each column is one selectable option
    grid = "grid"  # single-select matrix: columns share one categorical scale
    grid2d = "grid2d"  # two-dimensional grid: each column is a (row, col) cell


class AxisLabel(BaseModel):
    """A row or column of a 2-D grid: a stable ``key`` and its display ``label``."""

    key: str
    label: str


class QuestionItem(BaseModel):
    """One member column of a question, with its display label.

    For ``multi`` the label is the option; for ``grid`` it is the row/statement.
    For ``grid2d`` ``row``/``col`` locate the cell in the matrix (axis keys).
    """

    column: str
    label: str
    row: str | None = None
    col: str | None = None


class Question(BaseModel):
    """A matrix/grid question grouping several columns (a Displayr-style set).

    Source columns stay intact as variables; a question is a view over them so the
    grouping is reversible and existing features keep working.
    """

    id: str
    name: str
    label: str
    kind: QuestionKind
    items: list[QuestionItem] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list)  # shared scale for grid
    rows: list[AxisLabel] = Field(default_factory=list)  # grid2d row axis
    columns: list[AxisLabel] = Field(default_factory=list)  # grid2d column axis


class DatasetMeta(BaseModel):
    """Everything we know about an imported dataset except the raw rows."""

    id: str
    source_filename: str
    n_rows: int
    n_cols: int
    variables: list[Variable]
    questions: list["Question"] = Field(default_factory=list)
    filters: list["Filter"] = Field(default_factory=list)
    crosstabs: list["CrosstabNode"] = Field(default_factory=list)


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


class WeightRequest(BaseModel):
    """Create (or replace) a weight variable from a rim/rake definition."""

    name: str | None = None  # None → create a new weight; else update this one
    new_label: str
    spec: WeightSpec


class WeightPreview(BaseModel):
    """Sample-size diagnostics for a candidate weight, without saving it."""

    total_sample: float
    effective_sample: float
    efficiency: float  # effective / total, as a percentage


class CombinationsRequest(BaseModel):
    """Ask for the observed category combinations across some variables."""

    variables: list[str]
    include_missing: bool = False


class Combination(BaseModel):
    """One observed combination of category labels, with its sample share."""

    values: list[str]
    count: int
    percent: float


class CombinationsResponse(BaseModel):
    """Observed combinations for building weight targets."""

    combinations: list[Combination]


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


class QuestionsUpdate(BaseModel):
    """Payload for saving the dataset's matrix/grid questions."""

    questions: list[Question]


class CrosstabRowSpec(BaseModel):
    """What goes down the side of a crosstab: a variable or a grouped variable."""

    kind: Literal["variable", "question"]
    ref: str  # variable name, or question id when kind == "question"


class BannerSegment(BaseModel):
    """One side-by-side block of the banner (columns).

    ``variables`` holds 0, 1, or 2 variable names: [] is a Total column, [v] is
    one variable's categories side by side, and [v1, v2] nests v2 under each of
    v1's categories (two levels). Segments sit next to each other in the banner.
    """

    variables: list[str] = Field(default_factory=list)


class BannerColumnGroup(BaseModel):
    """A NET or merge of leaf categories within one banner segment.

    ``seg`` is the segment index; ``members`` are leaf-category labels. For a
    nested segment the group is applied within each parent category.
    """

    id: str
    seg: int
    label: str
    members: list[str]
    mode: Literal["net", "merge"]


class CrosstabGroup(BaseModel):
    """A NET or merge of several row/column categories.

    ``members`` are underlying category labels. ``merge`` replaces those
    categories with one combined category; ``net`` adds a subtotal while keeping
    the originals. Combining uses the union of respondents, so it is correct for
    pick-any rows (a respondent in two merged options is counted once).
    """

    id: str
    label: str
    members: list[str]
    mode: Literal["net", "merge"]


class CrosstabRequest(BaseModel):
    """Request a crosstab of one row source against one column variable."""

    row: CrosstabRowSpec
    column: str | None = None  # None → a single "Total" banner (whole sample)
    banner: list[BannerSegment] = Field(default_factory=list)  # nested/side-by-side
    banner_groups: list[BannerColumnGroup] = Field(default_factory=list)
    filter_id: str | None = None  # optional saved filter to restrict respondents
    weight: str | None = None  # optional weight-variable name
    row_groups: list[CrosstabGroup] = Field(default_factory=list)
    column_groups: list[CrosstabGroup] = Field(default_factory=list)


class CrosstabCell(BaseModel):
    """One cell of a crosstab. Extra statistics can be added over time."""

    count: float
    column_pct: float | None = None  # count / column base, as a percentage
    # Significance testing (column proportions, 95%):
    sig_higher: list[str] = Field(default_factory=list)  # letters of columns beaten
    sig_arrow: Literal["up", "down"] | None = None  # vs. rest of the sample


class CrosstabColumn(BaseModel):
    """A banner column: its label and valid base (denominator for column %)."""

    label: str
    base: float
    eff_base: float | None = None  # Kish effective sample size (weighted tables)
    letter: str | None = None  # column id (A, B, C…) for significance letters
    top_label: str = ""  # parent header (nested/side-by-side banners); "" = flat
    group: str = ""  # sub-group id: header span + significance comparison scope
    seg: int = -1  # banner segment index (-1 = legacy single-column mode)


class CrosstabResponse(BaseModel):
    """A computed crosstab: row labels, banner columns, and a grid of cells."""

    row_labels: list[str]
    row_values: list[float | None]  # numeric value per row (for mean/sum), or None
    columns: list[CrosstabColumn]
    cells: list[list[CrosstabCell]]  # cells[row][column]
    total_base: float
    total_eff_base: float | None = None  # overall Kish effective sample size
    weighted: bool = False
    row_kind: Literal["variable", "multi", "grid", "grid2d"]


class CrosstabDisplay(BaseModel):
    """Which statistics a saved crosstab shows (see CrosstabView)."""

    cell_stats: list[str] = Field(default_factory=lambda: ["count", "col_pct"])
    summary_rows: list[str] = Field(default_factory=lambda: ["base_n"])
    summary_cols: list[str] = Field(default_factory=list)
    significance: list[str] = Field(default_factory=list)  # "letters", "arrows"


class SavedCrosstabSpec(BaseModel):
    """Everything needed to reproduce a saved crosstab."""

    row: CrosstabRowSpec
    column: str | None = None  # None → Total-sample table (no column)
    banner: list[BannerSegment] = Field(default_factory=list)  # nested/side-by-side
    banner_groups: list[BannerColumnGroup] = Field(default_factory=list)
    filter_id: str | None = None
    weight: str | None = None
    display: CrosstabDisplay = Field(default_factory=CrosstabDisplay)
    row_groups: list[CrosstabGroup] = Field(default_factory=list)
    column_groups: list[CrosstabGroup] = Field(default_factory=list)
    # Display-only overrides (do not affect computation).
    row_renames: dict[str, str] = Field(default_factory=dict)
    column_renames: dict[str, str] = Field(default_factory=dict)
    row_hidden: list[str] = Field(default_factory=list)
    column_hidden: list[str] = Field(default_factory=list)
    # Sub-column (advanced banner) display-only overrides.
    banner_cat_renames: dict[str, str] = Field(default_factory=dict)
    banner_cat_hidden: list[str] = Field(default_factory=list)
    banner_parent_renames: dict[str, str] = Field(default_factory=dict)
    banner_parent_hidden: list[str] = Field(default_factory=list)
    # Display-only reorder: labels in the user's chosen order (others follow
    # natural order). Columns reorder within their banner parent/segment.
    row_order: list[str] = Field(default_factory=list)
    column_order: list[str] = Field(default_factory=list)


class CrosstabNode(BaseModel):
    """A node in the saved-crosstab tree: a folder or a saved crosstab.

    Folders hold ``children``; crosstabs hold a ``spec``. ``version`` lets the
    spec grow (nesting, weighting) while older saved tables still load.
    """

    id: str
    name: str
    kind: Literal["folder", "crosstab"]
    children: list["CrosstabNode"] = Field(default_factory=list)
    spec: SavedCrosstabSpec | None = None
    version: int = 1


class CrosstabsUpdate(BaseModel):
    """Payload for saving the dataset's saved-crosstab tree."""

    crosstabs: list[CrosstabNode]


class ExportTable(BaseModel):
    """One table to write to an Excel sheet: a display name and its spec."""

    name: str
    spec: SavedCrosstabSpec


class ExportRequest(BaseModel):
    """Export one or more crosstabs to a single workbook (one sheet each)."""

    tables: list[ExportTable]


# DatasetMeta references Filter before it is defined; resolve the forward ref.
CrosstabNode.model_rebuild()
DatasetMeta.model_rebuild()
