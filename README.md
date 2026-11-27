# StatsTool
Building a quant research stats analysis tool

This project is for a quantitative research statistical analysis tool, similar to DisplayR, Q and SPSS.
The project should be built as a local web application.

Key Capabilities:
- Load survey data (.csv and .sav)
- Crosstabbing tool
- Nested banners
- Filters
- Variable editing and creation
- Charting
- Saving/Loading projects
- Driver analysis
- Significance testing
- Weighting
- Export to Excel and Powerpoint

Core user journey:

CREATE PROJECT
      ↓
IMPORT DATA
      ↓
REVIEW / DEFINE METADATA
      ↓
CREATE VARIABLES / FILTERS
      ↓
CREATE CROSSTABS
      ↓
CREATE CHARTS
      ↓
SAVE PROJECT
      ↓
REOPEN LATER
      ↓
CONTINUE ANALYSIS

MVP: I can import one of my real Bupa survey datasets, label the variables, create an age group, filter to a customer segment, build a satisfaction-by-age crosstab, turn it into a chart, save the project, and reopen it next week without rebuilding anything.

## Running locally

The app has two parts: a Python (FastAPI) backend and a React (Vite) frontend. Run each in its own terminal.

### First-time setup (once)

Backend:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Frontend:

```bash
cd frontend
npm install
```

### Start the app (every time)

Terminal 1 — backend API on port 8000:

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload
```

Terminal 2 — frontend on port 5173:

```bash
cd frontend
npm run dev
```

Then open http://localhost:5173 in your browser.

### Notes

- Keep both terminals running. Vite proxies `/api` requests to the backend at http://localhost:8000.
- Stop either server with Ctrl+C.
- Both auto-reload on code changes (uvicorn `--reload`, Vite HMR).
- Datasets are stored locally under `data/datasets/`.

### Crosstab weighting

When a crosstab uses a weight, respondent weights are calculated on the full
dataset before applying the table filter. Filtering retains those weights without
re-raking or renormalising them. Equivalent respondent subsets therefore produce
the same weighted results whether selected through a filter or a table column.
This applies to standard crosstabs, grid and correlation tables, and Excel exports.
Weighted bases are sums of respondent weights, not actual respondent counts.

### Derived variable sources

Expand a derived variable with **View** or the expand arrow to see a source
footnote beneath its values. It lists only the original source variable names
and labels, tracing through intermediate derived inputs and removing duplicates.
Derived grouped variables show the same footnote beneath their member list.
Segmentation source indicators are recorded when saving a membership variable;
older variables use their linked saved segmentation where available, or explicitly
show that the source variables were not recorded.

### Filtering Pick Any questions

The filter condition variable dropdown groups Pick Any options under their
question. Choose an option (for example **None of the above**) and use **is
selected** or **is not selected**. Conditions can be combined with AND/OR to
match several options. These filters also work in rule-based variable creation.
Selecting an option tests its non-missing member value, as in Pick Any crosstabs;
**is not selected** includes respondents with no answer to the question.