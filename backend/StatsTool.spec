# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec to build StatsTool.app (macOS). Run from backend/:
#   pyinstaller --clean --noconfirm StatsTool.spec
# Requires the frontend to be built first (../frontend/dist).

from PyInstaller.utils.hooks import collect_all, collect_submodules

datas, binaries, hiddenimports = [], [], []
for pkg in (
    "pandas",
    "numpy",
    "pyarrow",
    "openpyxl",
    "fastapi",
    "starlette",
    "uvicorn",
    "pydantic",
    "pydantic_core",
    "multipart",
    "anyio",
):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

hiddenimports += collect_submodules("app")
hiddenimports += collect_submodules("uvicorn")

# Bundle the built frontend next to the app (resolved by desktop.py).
datas += [("../frontend/dist", "frontend_dist")]

a = Analysis(
    ["desktop.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "pytest", "IPython"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="StatsTool",
    console=False,
    disable_windowed_traceback=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="StatsTool")
app = BUNDLE(
    coll,
    name="StatsTool.app",
    bundle_identifier="com.statstool.app",
    info_plist={"NSHighResolutionCapable": True},
)
