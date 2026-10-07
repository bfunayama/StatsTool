"""Apply an analysis (a project) onto another data set as a template.

A template is just a ``DatasetMeta`` (the saved analysis) that we re-home onto a
different ``DataSet`` by matching on COLUMN NAME. Anything whose columns are not
present in the target is dropped, so the result is always a valid project for the
target's rows.
"""

from __future__ import annotations

from .models import DataSet, DatasetMeta, Variable, VariableType


def apply_template(template: DatasetMeta, target: DataSet) -> DatasetMeta:
    """Build a new project for ``target`` from ``template``'s analysis.

    Raw columns come from the target (so the parquet always validates); the
    template's metadata (types, value attributes, recodes), derived variables,
    questions, filters, and saved crosstabs are carried over only where every
    column they reference exists in the target.
    """
    target_cols = {v.name for v in target.variables}
    tmpl_by_name = {v.name: v for v in template.variables}

    # Questions survive only if every member column is present in the target.
    kept_questions = [
        q
        for q in template.questions
        if q.items and all(it.column in target_cols for it in q.items)
    ]
    kept_qids = {q.id for q in kept_questions}
    col_qid: dict[str, str] = {}
    for q in kept_questions:
        for it in q.items:
            col_qid[it.column] = q.id

    out_vars: list[Variable] = []
    final_names: set[str] = set()

    # 1) Every target raw column, with the template's metadata overlaid by name.
    for base in target.variables:
        t = tmpl_by_name.get(base.name)
        if t is not None and t.source_name is None and t.type != VariableType.weight:
            v = t.model_copy(deep=True)
        else:
            v = base.model_copy(deep=True)
        v.question_id = col_qid.get(base.name)
        out_vars.append(v)
        final_names.add(v.name)

    # 2) Derived variables whose source resolves (fixpoint: a derived var may
    #    build on another derived var defined later in the template).
    pending = [
        t
        for t in template.variables
        if t.name not in final_names
        and t.type != VariableType.weight
        and t.source_name is not None
    ]
    added = True
    while added:
        added = False
        for t in list(pending):
            if t.source_name in final_names:
                v = t.model_copy(deep=True)
                v.question_id = t.question_id if t.question_id in kept_qids else None
                out_vars.append(v)
                final_names.add(v.name)
                pending.remove(t)
                added = True

    # 3) Weight variables whose rim variables all resolve.
    for t in template.variables:
        if t.type != VariableType.weight or t.name in final_names:
            continue
        spec = t.weighting
        rim_vars = [rv for rim in (spec.rims if spec else []) for rv in rim.variables]
        if rim_vars and all(rv in final_names for rv in rim_vars):
            out_vars.append(t.model_copy(deep=True))
            final_names.add(t.name)

    # 4) Filters whose every condition variable resolves.
    kept_filters = [
        f
        for f in template.filters
        if f.conditions and all(c.variable in final_names for c in f.conditions)
    ]
    kept_filter_ids = {f.id for f in kept_filters}

    # 5) Prune the saved-crosstab tree to tables whose references all resolve.
    kept_crosstabs = _prune_nodes(
        template.crosstabs, final_names, kept_qids, kept_filter_ids
    )

    return DatasetMeta(
        id="",  # caller assigns a fresh id
        source_filename=target.source_filename,
        n_rows=target.n_rows,
        n_cols=target.n_cols,
        data_id=target.id,
        name=template.name or template.source_filename,
        variables=out_vars,
        questions=kept_questions,
        filters=kept_filters,
        crosstabs=kept_crosstabs,
    )


def _spec_resolves(spec, var_names, qids, filter_ids) -> bool:
    row = spec.row
    if row.kind == "variable" and row.ref not in var_names:
        return False
    if row.kind == "question" and row.ref not in qids:
        return False
    if spec.column and spec.column not in var_names:
        return False
    for seg in spec.banner:
        if seg.question is not None:
            if seg.question not in qids:
                return False
        elif any(v not in var_names for v in seg.variables):
            return False
    if spec.weight and spec.weight not in var_names:
        return False
    if spec.filter_id and spec.filter_id not in filter_ids:
        return False
    if spec.correlation and spec.corr_with:
        if spec.corr_with not in qids and spec.corr_with not in var_names:
            return False
    return True


def _prune_nodes(nodes, var_names, qids, filter_ids):
    out = []
    for n in nodes:
        if n.kind == "folder":
            copy = n.model_copy(deep=True)
            copy.children = _prune_nodes(n.children, var_names, qids, filter_ids)
            out.append(copy)
        elif n.spec and _spec_resolves(n.spec, var_names, qids, filter_ids):
            out.append(n.model_copy(deep=True))
    return out
