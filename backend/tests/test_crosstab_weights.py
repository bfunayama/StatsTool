import unittest
from unittest.mock import patch

import pandas as pd

from app import compute, crosstab, export
from app.models import (
    Condition,
    CrosstabRequest,
    CrosstabRowSpec,
    DatasetMeta,
    Filter,
    Question,
    QuestionItem,
    SavedCrosstabSpec,
    Variable,
    WeightCell,
    WeightRim,
    WeightSpec,
)


class CrosstabWeightTests(unittest.TestCase):
    def setUp(self):
        self.df = pd.DataFrame(
            {
                "segment": ["Couples"] * 3 + ["Singles"] * 3,
                "age": ["Young", "Young", "Older", "Young", "Older", "Older"],
                "appeal": ["Yes", "No", "Yes", "No", "Yes", "Yes"],
                "x": [1, 2, 3, 4, 5, 6],
                "y": [1, 4, 2, 5, 3, 6],
            },
            index=[10, 20, 30, 40, 50, 60],
        )
        variables = [
            Variable(name=name, label=name, type="categorical")
            for name in ("segment", "age", "appeal")
        ] + [
            Variable(name=name, label=name, type="numeric") for name in ("x", "y")
        ]
        variables.append(
            Variable(
                name="weight",
                label="weight",
                type="weight",
                weighting=WeightSpec(
                    rims=[
                        WeightRim(
                            id="age",
                            variables=["age"],
                            cells=[
                                WeightCell(values=["Young"], percent=25),
                                WeightCell(values=["Older"], percent=75),
                            ],
                        )
                    ]
                ),
            )
        )
        self.meta = DatasetMeta(
            id="test",
            source_filename="test.csv",
            n_rows=6,
            n_cols=5,
            variables=variables,
            filters=[
                Filter(
                    id="couples",
                    name="Couples",
                    conditions=[
                        Condition(variable="segment", operator="in", values=["Couples"])
                    ],
                ),
                Filter(
                    id="empty",
                    name="Empty",
                    conditions=[
                        Condition(variable="segment", operator="in", values=["Absent"])
                    ],
                ),
            ],
            questions=[
                Question(
                    id="grid",
                    name="Grid",
                    label="Grid",
                    kind="grid",
                    categories=["Yes", "No"],
                    items=[QuestionItem(column="appeal", label="Appeal")],
                )
            ],
        )

    def request(self, **changes):
        return CrosstabRequest(
            row=CrosstabRowSpec(kind="variable", ref="appeal"),
            weight="weight",
        ).model_copy(update=changes)

    def test_filtered_table_matches_column_subset_without_renormalising(self):
        full = crosstab.compute_crosstab(self.df, self.meta, self.request(column="segment"))
        filtered = crosstab.compute_crosstab(
            self.df, self.meta, self.request(filter_id="couples")
        )
        ci = next(i for i, col in enumerate(full.columns) if col.label == "Couples")
        self.assertAlmostEqual(filtered.columns[0].base, 2.5)
        for label in filtered.row_labels:
            ri = filtered.row_labels.index(label)
            fi = full.row_labels.index(label)
            self.assertAlmostEqual(filtered.cells[ri][0].count, full.cells[fi][ci].count)
            self.assertAlmostEqual(
                filtered.cells[ri][0].column_pct, full.cells[fi][ci].column_pct
            )
        self.assertAlmostEqual(filtered.total_base, full.columns[ci].base)
        self.assertAlmostEqual(filtered.total_eff_base, full.columns[ci].eff_base)

    def test_grid_retains_full_dataset_weights(self):
        result = crosstab.compute_crosstab(
            self.df,
            self.meta,
            self.request(
                row=CrosstabRowSpec(kind="question", ref="grid"), filter_id="couples"
            ),
        )
        yes = next(i for i, col in enumerate(result.columns) if col.label == "Yes")
        self.assertAlmostEqual(result.cells[0][yes].count, 2.0)
        self.assertAlmostEqual(result.row_base[0], 2.5)

    def test_correlation_retains_full_dataset_weights(self):
        index = compute.build_index(self.meta.variables)
        weights = compute.compute_weights(self.df, index, index["weight"]).loc[[10, 20, 30]]
        expected = crosstab._pearson(
            self.df.loc[weights.index, "x"].to_numpy(float),
            self.df.loc[weights.index, "y"].to_numpy(float),
            weights.to_numpy(float),
        )
        result = crosstab.compute_crosstab(
            self.df,
            self.meta,
            self.request(
                row=CrosstabRowSpec(kind="variable", ref="x"),
                corr_with="y",
                correlation=True,
                filter_id="couples",
            ),
        )
        self.assertAlmostEqual(result.cells[0][0].corr, expected)
        self.assertEqual(result.cells[0][0].count, 3)

    def test_weight_is_computed_once_on_full_dataset_for_each_table_mode(self):
        for row, correlation in (
            (CrosstabRowSpec(kind="variable", ref="appeal"), False),
            (CrosstabRowSpec(kind="question", ref="grid"), False),
            (CrosstabRowSpec(kind="variable", ref="x"), True),
        ):
            with self.subTest(row=row), patch.object(
                compute, "compute_weights", wraps=compute.compute_weights
            ) as calculate:
                crosstab.compute_crosstab(
                    self.df,
                    self.meta,
                    self.request(
                        row=row,
                        correlation=correlation,
                        corr_with="y",
                        filter_id="couples",
                    ),
                )
                self.assertEqual(calculate.call_count, 1)
                self.assertIs(calculate.call_args.args[0], self.df)

    def test_unweighted_and_empty_filtered_tables(self):
        result = crosstab.compute_crosstab(
            self.df, self.meta, self.request(filter_id="couples", weight=None)
        )
        self.assertFalse(result.weighted)
        self.assertEqual(result.total_base, 3)
        empty = crosstab.compute_crosstab(
            self.df, self.meta, self.request(filter_id="empty")
        )
        self.assertTrue(empty.weighted)
        self.assertEqual(empty.total_base, 0)

    def test_excel_request_uses_same_filtered_weighted_calculation(self):
        spec = SavedCrosstabSpec(
            row=CrosstabRowSpec(kind="variable", ref="appeal"),
            filter_id="couples",
            weight="weight",
        )
        result = crosstab.compute_crosstab(
            self.df, self.meta, export._request_from_spec(spec)
        )
        self.assertAlmostEqual(result.total_base, 2.5)


if __name__ == "__main__":
    unittest.main()
