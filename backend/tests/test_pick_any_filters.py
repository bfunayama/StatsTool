import unittest

import pandas as pd

from app import compute, filters
from app.models import CompactSelectRecode, Condition, Filter, Variable


class PickAnyFilterTests(unittest.TestCase):
    def test_selected_and_unselected_compact_options(self):
        df = pd.DataFrame({"claims": ["None of the above", "Dental|Optical", None, "Dental"]})
        variables = [
            Variable(name="claims", label="Claims", type="categorical"),
            Variable(
                name="none",
                label="None of the above",
                type="categorical",
                source_name="claims",
                recode=CompactSelectRecode(value="None of the above", delimiter="|"),
            ),
        ]
        index = compute.build_index(variables)
        for operator, expected in (
            ("not_missing", [True, False, False, False]),
            ("is_missing", [False, True, True, True]),
        ):
            with self.subTest(operator=operator):
                filt = Filter(
                    id="test",
                    name="No claims",
                    conditions=[Condition(variable="none", operator=operator)],
                )
                self.assertEqual(filters.evaluate_filter(df, index, filt).tolist(), expected)


if __name__ == "__main__":
    unittest.main()
