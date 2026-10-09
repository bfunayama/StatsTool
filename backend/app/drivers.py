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

import itertools
import math

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
    beta_std = np.linalg.pinv(rxx) @ rxy  # standardised OLS betas (reference column)

    pseudo = False  # logit reports McFadden pseudo-R² rather than R²
    if spec.method == "relative_weights":
        importance, r2, _ = _relative_weights(rxx, rxy)
    elif spec.method == "shapley":
        if p > _SHAPLEY_MAX:
            raise DriverError(
                f"Shapley is limited to {_SHAPLEY_MAX} drivers (you have {p}). "
                "Use relative weights, or reduce the number of drivers."
            )
        importance, r2 = _shapley(rxx, rxy)
    elif spec.method == "logit":
        uniq = np.unique(yv)
        if uniq.size != 2:
            raise DriverError(
                "Binary logit needs an outcome with exactly two values. Recode "
                "the outcome to two categories, or use relative weights / Shapley."
            )
        y01 = (yv == uniq.max()).astype(float)
        importance, r2 = _logit_relative_weights(rxx, dX / sd, y01, w)
        pseudo = True
    elif spec.method == "ordered_logit":
        uniq = np.unique(yv)
        if uniq.size < 3:
            raise DriverError(
                "Ordered logit needs an outcome with 3+ ordered categories. "
                "Use binary logit for a two-category outcome."
            )
        if uniq.size > _ORDLOGIT_MAX_LEVELS:
            raise DriverError(
                f"Ordered logit expects a short ordered scale; this outcome has "
                f"{uniq.size} values. Use relative weights for a continuous outcome."
            )
        ranks = {v: i for i, v in enumerate(np.sort(uniq))}
        y_ord = np.array([ranks[v] for v in yv])
        importance, r2 = _ordlogit_relative_weights(rxx, dX / sd, y_ord, w)
        pseudo = True
    else:
        raise DriverError("Unknown driver method.")

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
    if not pseudo and n - p - 1 > 0:
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


# Shapley sums over 2^k subsets, so cap the predictor count to stay responsive.
_SHAPLEY_MAX = 12


def _subset_r2(rxx: np.ndarray, rxy: np.ndarray, idx: tuple[int, ...]) -> float:
    """R² of regressing the outcome on the predictors in ``idx`` (from corr matrix)."""
    if not idx:
        return 0.0
    sub = rxx[np.ix_(idx, idx)]
    v = rxy[list(idx)]
    return float(v @ np.linalg.pinv(sub) @ v)


def _shapley(rxx: np.ndarray, rxy: np.ndarray) -> tuple[np.ndarray, float]:
    """Shapley value regression (LMG): average marginal R² over all orderings."""
    k = len(rxy)
    cache: dict[frozenset[int], float] = {}

    def r2(members: frozenset[int]) -> float:
        if members not in cache:
            cache[members] = _subset_r2(rxx, rxy, tuple(sorted(members)))
        return cache[members]

    lmg = np.zeros(k)
    for j in range(k):
        others = [i for i in range(k) if i != j]
        acc = 0.0
        for size in range(len(others) + 1):
            weight = (
                math.factorial(size)
                * math.factorial(k - size - 1)
                / math.factorial(k)
            )
            for combo in itertools.combinations(others, size):
                s = frozenset(combo)
                acc += weight * (r2(s | {j}) - r2(s))
        lmg[j] = acc
    return lmg, float(np.clip(lmg.sum(), 0.0, 1.0))


def _irls_logit(
    z: np.ndarray, y: np.ndarray, w: np.ndarray
) -> tuple[np.ndarray, float]:
    """Weighted logistic regression by IRLS; returns betas + McFadden pseudo-R²."""
    n, k = z.shape
    design = np.column_stack([np.ones(n), z])
    beta = np.zeros(k + 1)
    for _ in range(100):
        eta = np.clip(design @ beta, -30, 30)
        p = np.clip(1.0 / (1.0 + np.exp(-eta)), 1e-9, 1 - 1e-9)
        grad = design.T @ (w * (y - p))
        hess = design.T @ (design * (w * p * (1 - p))[:, None])
        step = np.linalg.pinv(hess) @ grad
        beta = beta + step
        if np.max(np.abs(step)) < 1e-8:
            break
    eta = np.clip(design @ beta, -30, 30)
    p = np.clip(1.0 / (1.0 + np.exp(-eta)), 1e-9, 1 - 1e-9)
    ll = float((w * (y * np.log(p) + (1 - y) * np.log(1 - p))).sum())
    pbar = min(max(float((w * y).sum() / w.sum()), 1e-9), 1 - 1e-9)
    ll0 = float((w * (y * np.log(pbar) + (1 - y) * np.log(1 - pbar))).sum())
    pseudo = 1.0 - ll / ll0 if ll0 != 0 else 0.0
    return beta, max(pseudo, 0.0)


def _logit_relative_weights(
    rxx: np.ndarray, x_std: np.ndarray, y01: np.ndarray, w: np.ndarray
) -> tuple[np.ndarray, float]:
    """Relative weights for a binary outcome (Tonidandel & LeBreton).

    Orthogonalise the predictors, fit weighted logistic regression on them, then
    split the model's pseudo-R² across the original predictors.
    """
    evals, vecs = np.linalg.eigh(rxx)
    evals = np.clip(evals, 1e-12, None)
    root = vecs @ np.diag(np.sqrt(evals)) @ vecs.T
    root_inv = vecs @ np.diag(1.0 / np.sqrt(evals)) @ vecs.T
    z = x_std @ root_inv  # near-orthonormal predictors
    beta, pseudo_r2 = _irls_logit(z, y01, w)
    eps = (root**2) @ (beta[1:] ** 2)  # exclude the intercept
    total = float(eps.sum())
    if total > 0:
        eps = eps / total * pseudo_r2  # scale raw weights to the pseudo-R²
    return eps, pseudo_r2


# Ordered logit expects a short ordered scale, not a near-continuous variable.
_ORDLOGIT_MAX_LEVELS = 15


def _ordered_logit(
    z: np.ndarray, y: np.ndarray, w: np.ndarray
) -> tuple[np.ndarray, float]:
    """Proportional-odds ordered logit by Newton's method (weighted MLE).

    ``y`` is coded 0..K-1. Thresholds use an exp-increment parameterisation so
    they stay ordered. Returns the predictor slopes β and McFadden pseudo-R².
    """
    n, p = z.shape
    k = int(y.max()) + 1
    m = k - 1  # number of thresholds

    counts = np.array([w[y == j].sum() for j in range(k)], dtype=float)
    props = np.clip(counts / counts.sum(), 1e-9, 1.0)
    cum = np.clip(np.cumsum(props)[:-1], 1e-6, 1 - 1e-6)
    alpha0 = np.log(cum / (1 - cum))
    theta = np.concatenate(
        [
            [alpha0[0]],
            np.log(np.clip(np.diff(alpha0), 1e-3, None)) if m > 1 else [],
            np.zeros(p),
        ]
    )
    idx = np.arange(n)

    def thresholds(t: np.ndarray) -> np.ndarray:
        if m == 1:
            return t[:1]
        return t[0] + np.concatenate([[0.0], np.cumsum(np.exp(t[1:m]))])

    def loglik(t: np.ndarray) -> float:
        alpha = thresholds(t)
        eta = z @ t[m:]
        s = 1.0 / (1.0 + np.exp(-np.clip(alpha[None, :] - eta[:, None], -30, 30)))
        a = np.concatenate([np.zeros((n, 1)), s, np.ones((n, 1))], axis=1)
        prob = np.clip(a[idx, y + 1] - a[idx, y], 1e-12, 1.0)
        return float((w * np.log(prob)).sum())

    def grad(t: np.ndarray) -> np.ndarray:
        alpha = thresholds(t)
        beta = t[m:]
        eta = z @ beta
        s = 1.0 / (1.0 + np.exp(-np.clip(alpha[None, :] - eta[:, None], -30, 30)))
        a = np.concatenate([np.zeros((n, 1)), s, np.ones((n, 1))], axis=1)
        prob = np.clip(a[idx, y + 1] - a[idx, y], 1e-12, 1.0)
        g = s * (1 - s)  # σ' at each threshold
        d_alpha = np.zeros((n, m))
        up = y < m  # observation uses an upper threshold (not the top category)
        d_alpha[idx[up], y[up]] += g[idx[up], y[up]] / prob[up]
        lo = y > 0  # observation uses a lower threshold (not the bottom category)
        d_alpha[idx[lo], y[lo] - 1] -= g[idx[lo], y[lo] - 1] / prob[lo]
        d_alpha *= w[:, None]
        grad_alpha = d_alpha.sum(axis=0)
        g_up = np.where(up, g[idx, np.clip(y, 0, m - 1)], 0.0)
        g_lo = np.where(lo, g[idx, np.clip(y - 1, 0, m - 1)], 0.0)
        d_eta = (-g_up + g_lo) / prob
        grad_beta = (z * (w * d_eta)[:, None]).sum(axis=0)
        grad_t0 = grad_alpha.sum()
        if m > 1:
            grad_d = np.array(
                [np.exp(t[1 + i]) * grad_alpha[i + 1 :].sum() for i in range(m - 1)]
            )
        else:
            grad_d = np.array([])
        return np.concatenate([[grad_t0], grad_d, grad_beta])

    ll = loglik(theta)
    for _ in range(100):
        g0 = grad(theta)
        hess = np.zeros((theta.size, theta.size))
        for col in range(theta.size):
            bumped = theta.copy()
            bumped[col] += 1e-5
            hess[:, col] = (grad(bumped) - g0) / 1e-5
        hess = 0.5 * (hess + hess.T)
        step = -np.linalg.pinv(hess - 1e-6 * np.eye(theta.size)) @ g0
        scale = 1.0
        for _bt in range(30):
            cand = theta + scale * step
            if loglik(cand) >= ll:
                theta, ll = cand, loglik(cand)
                break
            scale *= 0.5
        else:
            break
        if np.max(np.abs(scale * step)) < 1e-7:
            break

    ll0 = float((w * np.log(props[y])).sum())  # intercept-only (base rates)
    pseudo = 1.0 - ll / ll0 if ll0 != 0 else 0.0
    return theta[m:], max(pseudo, 0.0)


def _ordlogit_relative_weights(
    rxx: np.ndarray, x_std: np.ndarray, y_ord: np.ndarray, w: np.ndarray
) -> tuple[np.ndarray, float]:
    """Relative weights for an ordinal outcome via proportional-odds ordered logit."""
    evals, vecs = np.linalg.eigh(rxx)
    evals = np.clip(evals, 1e-12, None)
    root = vecs @ np.diag(np.sqrt(evals)) @ vecs.T
    root_inv = vecs @ np.diag(1.0 / np.sqrt(evals)) @ vecs.T
    z = x_std @ root_inv
    beta, pseudo_r2 = _ordered_logit(z, y_ord, w)
    eps = (root**2) @ (beta**2)
    total = float(eps.sum())
    if total > 0:
        eps = eps / total * pseudo_r2
    return eps, pseudo_r2
