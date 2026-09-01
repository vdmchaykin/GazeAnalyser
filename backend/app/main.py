from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from app.database import init_db
from app.paths import DATA_DIR, ensure_dirs
from app.api.routes import recordings, projects, gaze, events, aoi, export, motion


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    await init_db()
    yield


app = FastAPI(title="PupilLabsReplacer API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:1420",   # vite dev
        "http://localhost:5173",   # vite preview
        "tauri://localhost",       # bundled app (Linux/macOS)
        "http://tauri.localhost",  # bundled app (Windows)
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(recordings.router)
app.include_router(projects.router)
app.include_router(gaze.router)
app.include_router(events.router)
app.include_router(aoi.router)
app.include_router(aoi.project_router)
app.include_router(export.router)
app.include_router(motion.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "0.1.0", "data_dir": str(DATA_DIR)}
