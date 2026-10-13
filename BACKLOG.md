# Backlog

Planned features not yet implemented. Each entry is a lightweight spec, not a commitment to a design.

These are roadmap capabilities from the README that are **not yet built**:
- **Export to PowerPoint** — only Excel (`export/xlsx`) and project export exist today.
- **Charting** — no charting UI/library in the frontend yet ("CREATE CHARTS" journey step).
- **.sav (SPSS) import** — import is CSV-only; no SPSS/`pyreadstat` reader yet.

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

**Status:** Backlog
**Requested:** 2026-10-13

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

**Status:** Backlog
**Requested:** 2026-10-13
**Similar to:** Displayr's text categorisation / manual coding tool.

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
