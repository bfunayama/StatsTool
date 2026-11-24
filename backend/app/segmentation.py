"""Latent class segmentation: a categorical mixture model fitted by EM.

Respondents are grouped into ``k`` latent classes. Within a class, answers to
each indicator variable are treated as independent, so a solution is described
by the class shares and each class's answer probabilities. Every solution is
fitted from several random starts (the best likelihood wins). When the analysis
is left to suggest the number of classes, the solution with the lowest BIC is
chosen. Each respondent is assigned to their most likely class.

Respondents are fitted on the filtered, weighted base with complete answers to
every indicator. Class membership is then assigned to every complete respondent
with a positive weight, so the saved variable covers the whole dataset.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import compute
from . import filters as filtering
from .models import (
    DatasetMeta,
    SegmentClass,
    SegmentationFitRow,
    SegmentationResponse,
    SegmentationSpec,
    SegmentProfile,
    SegmentProfileRow,
    Variable,
    VariableType,
)

MIN_CLASSES = 2
MAX_CLASSES = 10
MAX_CATEGORIES = 12  # answer categories allowed per indicator
MIN_BASE = 30  # fewest complete respondents needed to fit
MIN_CLASS_SHARE = 0.01  # a class holding under 1% of the base has collapsed
N_STARTS = 10  # random starts per number of classes
MAX_ITER = 1000
TOL = 1e-8
SEED = 20240601  # fixed so the same data and settings give the same answer
_FLOOR = 1e-10


class SegmentationError(ValueError):
    """The segmentation cannot be fitted with the settings given."""


@dataclass
class _Fit:
    """One fitted solution: class shares, answer probabilities and log-likelihood."""

    pi: np.ndarray  # (k,) class shares
    theta: list[np.ndarray]  # per indicator, (k, K_j) answer probabilities
    loglik: float


def compute_segmentation(
    df: pd.DataFrame, meta: DatasetMeta, spec: SegmentationSpec
) -> SegmentationResponse:
    """Fit the segmentation described by ``spec`` and return its results."""
    response, _ = segment_respondents(df, meta, spec)
    return response


def segment_respondents(
    df: pd.DataFrame, meta: DatasetMeta, spec: SegmentationSpec
) -> tuple[SegmentationResponse, np.ndarray]:
    """Fit the segmentation and assign every complete respondent to a class.

    Returns the results plus an integer array aligned with ``df`` rows: the class
    number (1 = largest) or 0 where the respondent was not classified.
    """
    index = compute.build_index(meta.variables)
    variables = _indicator_variables(meta, spec)
    keep, filter_label = _base_filter(df, meta, index, spec)
    weights, weight_label = _weights(df, index, meta, spec)
    usable = np.isfinite(weights) & (weights > 0)

    codes_list: list[np.ndarray] = []
    cats_list: list[list[str]] = []
    for var in variables:
        series = compute.compute_display_series(df, index, var)
        cats, codes = _encode(var, series)
        if len(cats) < 2:
            raise SegmentationError(
                f"'{var.label}' needs at least two answer categories."
            )
        if len(cats) > MAX_CATEGORIES:
            raise SegmentationError(
                f"'{var.label}' has {len(cats)} answer categories; use at most "
                f"{MAX_CATEGORIES} (band or recode it first)."
            )
        codes_list.append(codes)
        cats_list.append(cats)

    complete = usable.copy()
    for codes in codes_list:
        complete &= codes >= 0

    base_before_missing = int((keep & usable).sum())
    in_base = keep[complete]
    n_fit = int(in_base.sum())
    if n_fit < MIN_BASE:
        raise SegmentationError(
            f"Only {n_fit} complete responses in the base; at least {MIN_BASE} are "
            "needed."
        )

    onehot_all = [
        _one_hot(codes[complete], len(cats)) for codes, cats in zip(codes_list, cats_list)
    ]
    onehot_fit = [a[in_base] for a in onehot_all]
    w_base = weights[complete][in_base]
    # Scale weights so they sum to the number of fitted respondents. The
    # likelihood then matches an unweighted fit, and BIC uses the real count.
    w_fit = w_base * (n_fit / float(w_base.sum()))

    if spec.classes_mode == "fixed":
        _check_range(spec.n_classes, "Number of classes")
        candidates = [spec.n_classes]
    else:
        _check_range(spec.max_classes, "Maximum classes")
        candidates = list(range(MIN_CLASSES, spec.max_classes + 1))

    results: dict[int, _Fit] = {}
    fit_rows: list[SegmentationFitRow] = []
    entropy_by_k: dict[int, float | None] = {}
    for k in candidates:
        fit = _best_fit(onehot_fit, w_fit, k)
        if fit is None:
            continue
        results[k] = fit
        npar = (k - 1) + k * sum(a.shape[1] - 1 for a in onehot_fit)
        post = _posterior(onehot_fit, fit.pi, fit.theta)
        entropy = _entropy_r2(post, w_fit, k)
        entropy_by_k[k] = entropy
        fit_rows.append(
            SegmentationFitRow(
                k=k,
                log_likelihood=fit.loglik,
                npar=npar,
                aic=-2 * fit.loglik + 2 * npar,
                bic=-2 * fit.loglik + npar * math.log(n_fit),
                entropy_r2=entropy,
            )
        )

    if not results:
        raise SegmentationError(
            "No stable solution found. Try fewer classes or fewer indicators."
        )
    if spec.classes_mode == "fixed":
        if spec.n_classes not in results:
            raise SegmentationError(
                f"Could not find {spec.n_classes} distinct classes with these "
                "indicators. Try fewer classes."
            )
        chosen_k = spec.n_classes
    else:
        chosen_k = min(fit_rows, key=lambda row: row.bic).k

    # Order classes by size (largest first) so class 1 is always the biggest.
    chosen = results[chosen_k]
    order = np.argsort(-chosen.pi, kind="stable")
    pi = chosen.pi[order]
    theta = [t[order] for t in chosen.theta]

    member = _posterior(onehot_all, pi, theta).argmax(axis=1) + 1
    classes = np.zeros(len(df), dtype=int)
    classes[complete] = member

    fit_total = float(w_fit.sum())
    profiles: list[SegmentProfile] = []
    for var, cats, a_fit, t in zip(variables, cats_list, onehot_fit, theta):
        overall = (w_fit[:, None] * a_fit).sum(axis=0) / fit_total
        rows: list[SegmentProfileRow] = []
        for c, cat in enumerate(cats):
            overall_pct = float(overall[c]) * 100
            class_pcts = [float(x) * 100 for x in t[:, c]]
            class_index: list[float | None] = [
                None if overall_pct <= 0 else p / overall_pct * 100 for p in class_pcts
            ]
            rows.append(
                SegmentProfileRow(
                    label=cat,
                    overall_pct=overall_pct,
                    class_pcts=class_pcts,
                    class_index=class_index,
                )
            )
        profiles.append(SegmentProfile(name=var.name, label=var.label, rows=rows))

    response = SegmentationResponse(
        k=chosen_k,
        k_mode=spec.classes_mode,
        fit=fit_rows,
        classes=[
            SegmentClass(number=i + 1, size_pct=float(share) * 100)
            for i, share in enumerate(pi)
        ],
        profiles=profiles,
        entropy_r2=entropy_by_k.get(chosen_k),
        base_n=n_fit,
        eff_base_n=(
            compute.effective_n(pd.Series(w_fit)) if spec.weight else None
        ),
        excluded_missing=base_before_missing - n_fit,
        classified_n=int((classes > 0).sum()),
        weighted=spec.weight is not None,
        weight_label=weight_label,
        filter_label=filter_label,
    )
    return response, classes


def _check_range(value: int, label: str) -> None:
    if not MIN_CLASSES <= value <= MAX_CLASSES:
        raise SegmentationError(
            f"{label} must be between {MIN_CLASSES} and {MAX_CLASSES}."
        )


def _find_variable(meta: DatasetMeta, name: str) -> Variable:
    var = next((v for v in meta.variables if v.name == name), None)
    if var is None:
        raise SegmentationError(f"Unknown variable: {name}")
    return var


def _indicator_variables(meta: DatasetMeta, spec: SegmentationSpec) -> list[Variable]:
    if len(spec.indicators) < 2:
        raise SegmentationError("Choose at least two indicator variables.")
    if len(set(spec.indicators)) != len(spec.indicators):
        raise SegmentationError("Each indicator variable can only be chosen once.")
    variables: list[Variable] = []
    for name in spec.indicators:
        var = _find_variable(meta, name)
        if var.type in (VariableType.weight, VariableType.text, VariableType.datetime):
            raise SegmentationError(
                f"'{var.label}' cannot be an indicator; choose a categorical variable."
            )
        variables.append(var)
    return variables


def _base_filter(
    df: pd.DataFrame,
    meta: DatasetMeta,
    index: dict[str, Variable],
    spec: SegmentationSpec,
) -> tuple[np.ndarray, str | None]:
    if not spec.filter_id:
        return np.ones(len(df), dtype=bool), None
    saved = next((f for f in meta.filters if f.id == spec.filter_id), None)
    if saved is None:
        raise SegmentationError("The selected filter no longer exists.")
    mask = filtering.evaluate_filter(df, index, saved)
    return np.asarray(mask, dtype=bool), saved.name


def _weights(
    df: pd.DataFrame,
    index: dict[str, Variable],
    meta: DatasetMeta,
    spec: SegmentationSpec,
) -> tuple[np.ndarray, str | None]:
    if not spec.weight:
        return np.ones(len(df)), None
    var = _find_variable(meta, spec.weight)
    if var.type is not VariableType.weight:
        raise SegmentationError("The selected weight is not a weight variable.")
    values = compute.compute_weights(df, index, var).to_numpy(dtype=float)
    return values, var.label


def _label(value: object) -> str:
    if isinstance(value, (float, np.floating)) and float(value).is_integer():
        return str(int(value))
    return str(value)


def _sort_key(label: str) -> tuple[int, float, str]:
    try:
        return (0, float(label), label)
    except ValueError:
        return (1, 0.0, label)


def _encode(var: Variable, series: pd.Series) -> tuple[list[str], np.ndarray]:
    """Answer labels (display order) and each respondent's category index.

    Missing answers get -1.
    """
    labels = series.map(lambda v: None if pd.isna(v) else _label(v))
    present = set(labels.dropna().tolist())
    ordered = [c for c in (compute.label_order(var) or []) if c in present]
    rest = sorted(present - set(ordered), key=_sort_key)
    cats = list(dict.fromkeys(ordered + rest))
    lookup = {c: i for i, c in enumerate(cats)}
    codes = labels.map(lambda v: -1 if pd.isna(v) else lookup[v])
    return cats, codes.to_numpy(dtype=int)


def _one_hot(codes: np.ndarray, n_cats: int) -> np.ndarray:
    out = np.zeros((codes.shape[0], n_cats))
    out[np.arange(codes.shape[0]), codes] = 1.0
    return out


def _log_joint(
    onehot: list[np.ndarray], pi: np.ndarray, theta: list[np.ndarray]
) -> np.ndarray:
    """log P(class k) + sum over indicators of log P(answer | class k), per row."""
    n = onehot[0].shape[0]
    out = np.broadcast_to(np.log(pi), (n, pi.shape[0])).copy()
    for a, t in zip(onehot, theta):
        out += a @ np.log(t).T
    return out


def _logsumexp(log_joint: np.ndarray) -> np.ndarray:
    m = log_joint.max(axis=1)
    return m + np.log(np.exp(log_joint - m[:, None]).sum(axis=1))


def _weighted_loglik(log_joint: np.ndarray, w: np.ndarray) -> float:
    return float(np.dot(w, _logsumexp(log_joint)))


def _posterior(
    onehot: list[np.ndarray], pi: np.ndarray, theta: list[np.ndarray]
) -> np.ndarray:
    """Probability of each class for every row (rows sum to 1)."""
    log_joint = _log_joint(onehot, pi, theta)
    return np.exp(log_joint - _logsumexp(log_joint)[:, None])


def _entropy_r2(post: np.ndarray, w: np.ndarray, k: int) -> float | None:
    """Entropy R²: how cleanly respondents separate into classes (1 = perfect)."""
    if k < 2:
        return None
    p = np.clip(post, _FLOOR, 1.0)
    total = float(-(w[:, None] * post * np.log(p)).sum())
    return 1.0 - total / (float(w.sum()) * math.log(k))


def _em(
    onehot: list[np.ndarray], w: np.ndarray, k: int, rng: np.random.Generator
) -> _Fit:
    """Run EM from one random start until the log-likelihood stops improving."""
    pi = rng.dirichlet(np.ones(k))
    theta = [rng.dirichlet(np.ones(a.shape[1]), size=k) for a in onehot]
    prev = -np.inf
    for _ in range(MAX_ITER):
        log_joint = _log_joint(onehot, pi, theta)
        loglik = _weighted_loglik(log_joint, w)
        resp = np.exp(log_joint - _logsumexp(log_joint)[:, None])
        rw = resp * w[:, None]
        class_w = rw.sum(axis=0) + _FLOOR
        pi = class_w / class_w.sum()
        theta = []
        for a in onehot:
            counts = rw.T @ a + _FLOOR
            theta.append(counts / counts.sum(axis=1, keepdims=True))
        if loglik - prev < TOL * (1 + abs(loglik)):
            break
        prev = loglik
    final = _weighted_loglik(_log_joint(onehot, pi, theta), w)
    return _Fit(pi=pi, theta=theta, loglik=final)


def _best_fit(onehot: list[np.ndarray], w: np.ndarray, k: int) -> _Fit | None:
    """Best of several random starts for ``k`` classes, skipping collapsed fits."""
    rng = np.random.default_rng(SEED + k)
    best: _Fit | None = None
    for _ in range(N_STARTS):
        fit = _em(onehot, w, k, rng)
        if float(fit.pi.min()) < MIN_CLASS_SHARE:
            continue
        if best is None or fit.loglik > best.loglik:
            best = fit
    return best
