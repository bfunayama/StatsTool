"""Driver (key-driver / relative importance) analysis.

Ranks how strongly each predictor ("driver") relates to a single numeric
outcome. The default method is Johnson's Relative Weights (epsilon): it
decomposes the model R² across the drivers in a way that is stable under the
heavy collinearity typical of survey batteries, then signs each weight by the
driver's zero-order correlation so detractors read as negative.

Reuses the numeric-series extraction from the crosstab/correlation engine so a
driver set can be a grid question's items or a hand-picked set of variables.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import compute, filters as filtering
from .crosstab import _corr_operand, _variable_numeric_series
from .models import (
    DatasetMeta,
    DriverResponse,
    DriverRow,
    DriverSpec,
    QuestionKind,
    VariableType,
)


class DriverError(ValueError):
    """A driver request that cannot be computed (bad variables, too few cases)."""


def compute_driver_analysis(
    df: pd.DataFrame, meta: DatasetMeta, spec: DriverSpec
) -> DriverResponse:
    if spec.method != "relative_weights":
        raise DriverError("That method is not available yet.")

    index = compute.build_index(meta.variables)

    filter_label = None
    if spec.filter_id:
        saved = next((f for f in meta.filters if f.id == spec.filter_id), None)
        if saved is None:
            raise DriverError("Filter not found.")
        df = df[filtering.evaluate_filter(df, index, saved)]
        filter_label = saved.name

    outcome_var = index.get(spec.outcome)
    if outcome_var is None:
        raise DriverError("Choose an outcome variable.")
    y = _variable_numeric_series(df, index, outcome_var)
    outcome_label = outcome_var.label

    series_list, labels, names = _resolve_drivers(df, index, meta, spec)
    if len(series_list) < 2:
        raise DriverError("Driver analysis needs at least two drivers.")

    frame = pd.DataFrame({f"d{i}": s for i, s in enumerate(series_list)})
    frame["_y"] = y

    weighted = False
    weight_label = None
    if spec.weight:
        wv = index.get(spec.weight)
        if wv is None or wv.type is not VariableType.weight:
            raise DriverError("Weight variable not found.")
        frame["_w"] = compute.compute_weights(df, index, wv)
        weight_label = wv.label
        weighted = True
    else:
        frame["_w"] = 1.0

    frame = frame.dropna()
    p = len(series_list)
    if frame.shape[0] < p + 2:
        raise DriverError(
            "Not enough complete responses for this many drivers. Remove drivers "
            "or widen the base."
        )

    xcols = [f"d{i}" for i in range(p)]
    trimmed = 0
    if spec.trim_outliers:
        frame, trimmed = _trim_outliers(frame, xcols + ["_y"], spec.outlier_pct, p)

    w = frame["_w"].to_numpy(dtype=float)
    X = frame[xcols].to_numpy(dtype=float)
    yv = frame["_y"].to_numpy(dtype=float)
    n = X.shape[0]

    sw = float(w.sum())
    if sw <= 0:
        raise DriverError("No usable responses after filtering.")
    mean_x = (w[:, None] * X).sum(axis=0) / sw
    mean_y = float((w * yv).sum() / sw)
    dX = X - mean_x
    dy = yv - mean_y
    cxx = (w[:, None] * dX).T @ dX / sw
    cxy = (dX * (w * dy)[:, None]).sum(axis=0) / sw
    sd = np.sqrt(np.diag(cxx))
    sdy = float(np.sqrt((w * dy * dy).sum() / sw))
    zero = [labels[i] for i in range(p) if sd[i] <= 0]
    if zero or sdy <= 0:
        who = zero[0] if zero else outcome_label
        raise DriverError(f"“{who}” has no variation in the current base.")

    rxx = cxx / np.outer(sd, sd)
    rxy = cxy / (sd * sdy)

    importance, r2, beta_std = _relative_weights(rxx, rxy)
    total = float(importance.sum())
    pct = importance / total * 100.0 if total > 0 else np.zeros_like(importance)
    signs = np.sign(rxy)

    rows = [
        DriverRow(
            name=names[i],
            label=labels[i],
            importance=float(importance[i]),
            importance_pct=float(pct[i]),
            signed_pct=float(pct[i] * (signs[i] if signs[i] != 0 else 1.0)),
            correlation=float(rxy[i]),
            beta=float(beta_std[i]),
            mean=float(mean_x[i]),
        )
        for i in range(p)
    ]
    rows.sort(key=lambda r: r.importance_pct, reverse=True)

    adj_r2 = None
    if n - p - 1 > 0:
        adj_r2 = 1.0 - (1.0 - r2) * (n - 1) / (n - p - 1)
    eff = compute.effective_n(frame["_w"]) if weighted else float(n)

    return DriverResponse(
        outcome_label=outcome_label,
        rows=rows,
        r2=r2,
        adj_r2=adj_r2,
        base_n=n,
        eff_base_n=eff,
        weighted=weighted,
        method=spec.method,
        weight_label=weight_label,
        filter_label=filter_label,
        trimmed=trimmed,
        n_drivers=p,
    )


def _resolve_drivers(
    df: pd.DataFrame, index, meta: DatasetMeta, spec: DriverSpec
) -> tuple[list[pd.Series], list[str], list[str]]:
    """Driver numeric series with their labels and stable names."""
    if spec.driver_kind == "question":
        q = next((x for x in meta.questions if x.id == spec.driver_question), None)
        if q is None or q.kind is not QuestionKind.grid:
            raise DriverError("Choose a numeric grid question for the drivers.")
        series, labels = _corr_operand(df, index, meta, "question", spec.driver_question)
        names = [item.column for item in q.items]
        return series, labels, names
    series: list[pd.Series] = []
    labels: list[str] = []
    names: list[str] = []
    for nm in spec.driver_variables:
        var = index.get(nm)
        if var is None:
            raise DriverError(f"Driver variable not found: {nm}")
        series.append(_variable_numeric_series(df, index, var))
        labels.append(var.label)
        names.append(nm)
    return series, labels, names


def _trim_outliers(
    frame: pd.DataFrame, cols: list[str], pct: float, p: int
) -> tuple[pd.DataFrame, int]:
    """Drop the ``pct`` most extreme rows by Mahalanobis distance over ``cols``."""
    if frame.shape[0] <= p + 2 or pct <= 0:
        return frame, 0
    m = frame[cols].to_numpy(dtype=float)
    mu = m.mean(axis=0)
    cov = np.cov(m, rowvar=False)
    try:
        inv = np.linalg.pinv(cov)
    except np.linalg.LinAlgError:
        return frame, 0
    d = m - mu
    md = np.einsum("ij,jk,ik->i", d, inv, d)
    cutoff = float(np.quantile(md, 1.0 - pct / 100.0))
    keep = md <= cutoff
    if keep.sum() < p + 2:  # never trim below a usable base
        return frame, 0
    return frame[keep], int((~keep).sum())


def _relative_weights(
    rxx: np.ndarray, rxy: np.ndarray
) -> tuple[np.ndarray, float, np.ndarray]:
    """Johnson's relative weights, model R², and standardised betas (reference)."""
    evals, vecs = np.linalg.eigh(rxx)
    evals = np.clip(evals, 1e-12, None)
    root = vecs @ np.diag(np.sqrt(evals)) @ vecs.T
    root_inv = vecs @ np.diag(1.0 / np.sqrt(evals)) @ vecs.T
    beta = root_inv @ rxy  # betas on the orthogonalised predictors
    importance = (root**2) @ (beta**2)  # ε_j = Σ_k λ_jk² β_k²
    r2 = float(np.clip(importance.sum(), 0.0, 1.0))
    beta_std = np.linalg.pinv(rxx) @ rxy  # ordinary standardised regression betas
    return importance, r2, beta_std
