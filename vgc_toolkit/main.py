"""FastAPI app entrypoint.

Run locally:
    uvicorn vgc_toolkit.main:app --reload
Interactive docs at http://127.0.0.1:8000/docs
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from vgc_toolkit.api.routes import router

app = FastAPI(title="Champions VGC Toolkit", version="0.1.0")

# Allow the Vite dev server during frontend development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

# If a built frontend exists (frontend/dist), serve it as the site root so
# the whole tool deploys as a single unit.
_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")
