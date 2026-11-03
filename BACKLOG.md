# Backlog

Planned features not yet implemented. Each entry is a lightweight spec, not a commitment to a design.

These are roadmap capabilities from the README that are **not yet built**:
- **Export to PowerPoint** — only Excel (`export/xlsx`) and project export exist today.
- **Charting** — no charting UI/library in the frontend yet ("CREATE CHARTS" journey step).
- **.sav (SPSS) import** — import is CSV-only; no SPSS/`pyreadstat` reader yet.

---

## Kano classification helper

**Status:** Backlog
**Added:** 2026-11-03

### Summary
A one-click tool to turn the two standard Kano questions (Functional + Dysfunctional,
each a 5-point grid over the same features) into per-feature Kano **category** variables
(A / O / M / I / R / Q), instead of hand-building 7 IF/AND/OR rules per feature.

### Behaviour
- Analyst picks the **Functional** question and the **Dysfunctional** question (grids
  whose rows are the same features), and maps the 5 scale points
  (Like / Expect / Neutral / Live-with / Dislike) to the two axes.
- For each feature, generate a categorical variable via the standard 5×5 Kano evaluation
  table → A/O/M/I/R/Q (first-match rule logic, already supported by the `rules` recode —
  this can reuse it under the hood).
- Optionally also auto-build the **comparison grid** (features × category) so the analyst
  gets the "% per category per feature" table immediately.
- Category display order A → O → M → I → R → Q.

### Notes
- Pure convenience over the existing **Rule-based** + **Compare side by side** flow (which
  already does this manually). The win is avoiding 7 rules × N features by hand.
- Count-across-columns is *not* involved in the classification; it could optionally add
  per-respondent summaries later (e.g. "number of features rated Attractive").

---

## Small bugs & tweaks

**Status:** ✅ Shipped (2026-11-03)
**Added:** 2026-11-03

- ✅ **Default New Table title** — the crosstab Title field now shows the computed default
  ("{row} by {column}") as its placeholder, and that name is used on save.
- ✅ **Combined-variable name field loses focus on first keystroke** — fixed: `labelEdited`
  is now a ref (not state) so typing no longer re-runs the preview effect that unmounted
  the input.
- ✅ **Reorder categories in the coding module** — ▲/▼ buttons reorder the category list;
  the order flows through to the created variable's value/member order on save.
- ✅ **Coding module Save/Cancel** — moved Cancel / Save into a sticky header; the modal is
  a flex column so the panes scroll internally and the actions are always visible.

---

## Count-across-columns variable creation

**Status:** ✅ Shipped (2026-11-03)
**Added:** 2026-11-03

Shipped: **New variable → Count across columns**. Pick a set of columns (or a Pick-Any/grid
question, which expands to its members) and count, per respondent, how many meet a
condition: **selected / has any answer**, **equals a value** (top-box counts), or
**most-common-answer frequency** (a straightlining data-quality metric, with in-dialog
helper text). No-answer = 0. Produces a numeric variable usable in filters, crosstabs,
drivers, charts and export (band it afterward with the Band tool). Backend: `count` recode
(`selected`/`equals`/`mode_freq`) + `POST /variables/count`.

### Summary
A new variable-creation type that counts, per respondent, how many of a chosen set of
columns meet a condition — producing a numeric (or banded categorical) variable.

### Uses
- **No. of brands selected** (count selected options across a pick-any set).
- **Straightliner counts** (how many grid rows share the same answer / flag straightlining).
- **Kano category** and similar derived classifications built from several columns.

### Notes
- Input: a set of columns (or a pick-any/grid question) + a "counts when" rule
  (selected / equals value / non-missing).
- Output: a numeric count variable (optionally banded into categories), landing in the
  Variables tab and usable in filters/crosstabs/drivers/charts/export.
- Sits alongside the other options in the **New variable** dialog.

---

## Rule-based Variable creation (IF / AND / OR logic)

**Status:** ✅ Shipped (2026-11-03)
**Requested:** 2026-10-13

Shipped: **New variable → From logic (IF / AND / OR)**. Ordered rules, each an output
category with conditions combined by **AND / OR** (reuses the filter condition builder and
engine). First match wins; unmatched respondents go to an optional **else** category or
missing. Produces a categorical variable usable everywhere. Backend: `rules` recode +
`POST /variables/rules`; `filters.evaluate_conditions` extracted for reuse. (Pick-Any
variant and in-place editing remain possible future enhancements.)

### Summary
A tool to create a new variable by defining logical rules over existing variables, e.g.
"IF age >= 65 AND region = 'North' THEN 'Older North'". Each rule maps a condition to an
output value/category; respondents matching no rule fall to a default/else (or missing).

### Behaviour
- Analyst builds an ordered list of **rules**; each rule = a condition → output category.
- Conditions support **AND / OR** grouping across multiple clauses, each clause being
  `variable operator value` (reuse the existing filter condition operators).
- Rules evaluate top-down; first match wins (mutually exclusive output), with an **else**
  category for unmatched respondents (or leave missing).
- Can produce a **Pick One** categorical variable (first-match) now; consider a Pick Any
  (any matching rule sets its member) variant later.
- Output variable lands in the Variables tab and is usable in filters, crosstabs, banners,
  drivers, charts, export.

### Notes
- Reuse / generalise the existing **filter condition** model (`filters.py`,
  `cond.variable` + operator + value; banner segments use similar condition logic) so the
  condition builder UI and evaluation are shared rather than reinvented.
- Persist the rule set on the derived `Variable` (a new recode kind, e.g. `rules`) so it
  can be edited and re-evaluated; keep references valid (prune if a source var is deleted).
- Validate: unknown variables/values, empty conditions, duplicate/one-100%-style issues
  surfaced inline.

### Acceptance criteria
- [ ] Analyst can add ordered rules with AND/OR condition groups and an output category.
- [ ] Unmatched respondents go to a defined else category (or missing).
- [ ] The created variable appears in the Variables tab and works in a crosstab, filter,
      and driver analysis.
- [ ] The rule set persists across save/reopen and can be edited later.

---

## Export to PowerPoint

**Status:** Backlog (README roadmap item)

### Summary
Export saved crosstabs (and, once charting exists, charts) to a `.pptx` deck, mirroring
the existing Excel export flow.

### Notes
- Reuse the structure of the Excel export (`export/xlsx` in `main.py`, `export.py`):
  same "export all / export selected / by folder" scoping and the saved-crosstab tree.
- Likely `python-pptx`: one slide per table (or per folder), table title + source note.
- Depends partly on **Charting** if chart slides are wanted; table slides can ship first.

---

## Charting

**Status:** Backlog (README roadmap item)

### Summary
Turn a crosstab into a chart (bar/stacked/line) that can be viewed, saved with the
project, and exported (Excel/PowerPoint).

### Notes
- Frontend currently has no chart component or library.
- Should read from the same crosstab result the table uses, so sig-testing/weighting
  carry through consistently.
- Feeds the PowerPoint export (chart slides) and the "CREATE CHARTS" core journey step.

---

## .sav (SPSS) import

**Status:** Backlog (README roadmap item)

### Summary
Import SPSS `.sav` files in addition to CSV, bringing across variable + value labels and
measurement levels so metadata is pre-populated.

### Notes
- Backend ingest is CSV-only today; add an SPSS reader (e.g. `pyreadstat`).
- Map SPSS variable/value labels onto the existing `Variable` value-attribute model and
  infer types (nominal/ordinal/scale) on import.

---

## Auto-save (remove manual Save buttons)

**Status:** ✅ Shipped (2026-11-03)
**Requested:** 2026-10-13

Shipped: manual Save buttons removed from both **Crosstabs** (no more "Save as table" — a
new table auto-saves once you pick a Row; edits auto-save into the open table, debounced)
and the **Variables tab** (debounced auto-save; the "save first" gates are gone; a
"Saving…/All changes saved" indicator replaces the button; cursor-safe via a self-echo
guard). Plus **global Undo/Redo**: session-only history over whole-analysis snapshots,
toolbar buttons + **⌘Z / ⌘⇧Z** (native undo still wins inside text fields), covers
deletions. Backend: atomic `PUT /datasets/{id}/meta` for undo/redo restore.

### Summary
Auto-save the analysis on every change so manual save actions can be removed. Applies to
both the Crosstabs module and the Variables tab.

### Behaviour
- **Crosstabs:** every edit to a table (row/column/banner/weight/filter/display/groups,
  rename, reorder, folder changes) persists automatically. Remove the **"Save table"**
  button — a table becomes part of the saved tree as soon as it's created/edited.
  - The crosstab tree already auto-persists structural changes via `persistTree` →
    `PUT /crosstabs`; extend this so builder edits to the *active* table save too, rather
    than only on an explicit "Save table".
  - **Change the default state of a new table** on "+ table": clicking "+ table" should
    create and immediately persist a sensible default crosstab (so there's always a
    concrete saved node to edit), instead of leaving an unsaved draft in the builder.
    Decide the default spec (e.g. first variable × Total).
- **Variables tab:** edits auto-save (debounced) instead of requiring a manual Save.
  - Keep the existing server-side validation/self-heal (orphaned-reference pruning) so an
    in-progress invalid edit can't wedge the save; surface validation inline rather than
    blocking via a disabled button.

### Notes / risks
- Debounce writes to avoid a request per keystroke; coalesce rapid edits.
- Preserve atomic writes (`_atomic_write_text`) to avoid partial-file reads under frequent
  saves.
- Provide lightweight save-state feedback (e.g. "Saving…/Saved") and non-blocking error
  handling if a save fails.
- Ensure auto-save doesn't fight the current "dirty"-gated row actions; revisit that
  gating once manual save is gone.

### Acceptance criteria
- [ ] No "Save table" button; table edits persist automatically.
- [ ] "+ table" creates a persisted default crosstab (defined default state).
- [ ] Variables tab changes auto-save (debounced) with inline validation, no manual Save.
- [ ] Rapid edits are debounced/coalesced; saves stay atomic; reopen shows latest state.

---

## Text Variable Coding Tool (verbatim categorisation)

**Status:** ✅ Shipped (v1, 2026-10-13)
**Requested:** 2026-10-13
**Similar to:** Displayr's text categorisation / manual coding tool.

**Shipped v1:** Launched from the Variables tab via **New variable… → Code open-ended
text**. Dual-pane coder: left pane lists **distinct** verbatims with counts (identical
responses grouped, e.g. `n/a (9)`, plus a `(No answer)` bucket); right pane holds flat
categories showing live `(col%, n=…)`. Plain / Shift / ⌘-Ctrl multi-select; click a
category to assign/unassign the selection. Produces **Pick One** (categorical) or
**Pick Any** (`multi` question of binary members); uncoded → missing. Coded variables are
re-openable/editable (**Edit codes…**) and work in filters/crosstabs/drivers/export.
Backend: `code_one`/`code_any` recodes (computed on the fly, keyed by verbatim value),
`GET …/verbatims`, `POST …/variables/text-code`. **v1 limitations:** single-level
categories only (no nesting); no auto/AI coding; single source column.

### Summary
A tool for manually coding open-ended ("verbatim") text responses into analyst-defined
categories, producing new variables that appear in the Variables tab and can be used
everywhere else (filters, crosstabs, banners, driver analysis, charts, export).

### UI — dual pane
- **Left pane:** scrollable list of the open-ended text responses for a chosen source
  text column (one row per respondent; show respondent id/index + the verbatim).
- **Right pane:** the analyst-defined **category list** for this coding job.
  - v1 scope: a **single-level** (flat) list of categories — no nesting (Displayr allows
    nested categories; defer that).
  - Each category has an editable name; categories can be added, renamed, reordered,
    and deleted.
- Show per-category counts (how many verbatims assigned) and overall coding progress
  (e.g. "72 / 97 coded").

### Core interaction
1. Analyst defines a preliminary list of categories in the right pane.
2. Analyst selects one or more verbatims in the left pane:
   - plain click = select single verbatim,
   - **Shift-click** = select contiguous range,
   - **Cmd/Ctrl-click** = toggle individual verbatims in/out of the selection.
3. Analyst clicks a category (or categories) in the right pane to assign the selected
   verbatim(s) to it/them. Clicking an already-assigned category unassigns it.
4. Assignments are reflected immediately (category chips/highlights on each verbatim row,
   updated counts).

### Variable types produced
The job can output either (chosen per coding job, mirroring Displayr):
- **Pick One (mutually exclusive):** one categorical variable; each respondent gets at
  most one category. Assigning a second category replaces the first.
  - Maps to an existing **categorical variable** (one value per respondent) — reuse the
    value-attribute machinery already used by other categorical variables.
- **Pick Any (non-mutually exclusive):** a set of binary member columns (one per
  category) grouped as a pick-any question; a respondent can be in multiple categories.
  - Maps to the existing **compact pick-any** pattern (see
    `variables/pick-any-compact` endpoints and `compute` pick-any selection via
    `.notna()`), so it crosstabs/NETs like other pick-any variables.

### Output / integration
- Created variable(s) land in the **Variables tab** and are first-class:
  usable in filters, crosstabs (row/column/banner), driver analysis, charts, export.
- Persist the coding job (source column, category list, per-respondent assignments,
  Pick One/Any mode) in the project so it can be reopened and edited; re-running
  regenerates/updates the derived variable(s).
- Uncoded respondents → missing (so they drop out of valid bases like other blanks).

### Out of scope for v1 (future)
- Nested / hierarchical categories.
- Auto-coding / AI-assisted suggestions, keyword search-to-code, fuzzy grouping.
- Multi-column / merged verbatim sources.
- Inter-coder reliability, code frequencies export, "other/uncoded" review workflows.

### Implementation notes (for when picked up)
- **Backend:** new persisted model for a coding job on `DatasetMeta` (source column,
  ordered categories with ids, assignment map respondent→category ids, mode). Endpoints:
  create/update job, and materialise it into variable(s). Reuse:
  - Pick One → categorical variable with value attributes.
  - Pick Any → compact pick-any (reuse `_compact_source_series` / pick-any-compact flow).
- **Frontend:** new dual-pane view/dialog; selection model must support plain/Shift/Cmd
  click. NEVER use native `confirm/alert/prompt` (shared Playwright auto-dismisses) —
  use in-app modals. Validate with `tsc --noEmit` + `oxlint`.
- Keep category ids stable so edits don't orphan assignments; prune assignments when a
  category is deleted.

### Acceptance criteria
- [ ] Analyst can pick a text column and see all verbatims in the left pane.
- [ ] Analyst can add/rename/reorder/delete categories in the right pane.
- [ ] Plain, Shift, and Cmd/Ctrl click selection all work on the verbatim list.
- [ ] Assigning selected verbatim(s) to one or more categories works; counts update live.
- [ ] Pick One enforces a single category per respondent; Pick Any allows multiple.
- [ ] Generated variable(s) appear in the Variables tab and work in a crosstab, a filter,
      and a driver analysis.
- [ ] The coding job persists across save/reopen and can be edited later.
