import aiosqlite

from app.paths import DB_PATH, RECORDINGS_DIR


async def get_db() -> aiosqlite.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    return db


async def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS recordings (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                wearer_name TEXT,
                start_time INTEGER,
                duration_ns INTEGER,
                gaze_frequency INTEGER,
                device_serial TEXT,
                app_version TEXT,
                folder_path TEXT NOT NULL,
                scene_video TEXT,
                eye_video TEXT,
                has_gaze_result INTEGER DEFAULT 0,
                imported_at TEXT DEFAULT (datetime('now'))
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS project_recordings (
                project_id TEXT,
                recording_id TEXT,
                PRIMARY KEY (project_id, recording_id),
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
            )
        """)
        await db.commit()
        await _reroot_recording_paths(db)


async def _reroot_recording_paths(db: aiosqlite.Connection) -> None:
    """Point stored paths at the current data directory.

    Import writes absolute paths, but a recording always lives at
    RECORDINGS_DIR/<id>. So when the data directory moves — a new machine, a
    different OS, GAZEANALYZER_DATA_DIR aimed somewhere else — the stored paths
    are stale while the files themselves are fine. Rebuild the folder from the
    current root and shift the video paths by the same prefix.
    """
    db.row_factory = aiosqlite.Row
    cur = await db.execute("SELECT id, folder_path, scene_video, eye_video FROM recordings")
    rows = await cur.fetchall()

    updates = []
    for row in rows:
        old_folder = row["folder_path"]
        new_folder = str(RECORDINGS_DIR / row["id"])
        if old_folder == new_folder:
            continue

        def shifted(p: str | None) -> str | None:
            if p and old_folder and p.startswith(old_folder):
                return new_folder + p[len(old_folder):]
            return p

        updates.append((new_folder, shifted(row["scene_video"]), shifted(row["eye_video"]), row["id"]))

    if updates:
        await db.executemany(
            "UPDATE recordings SET folder_path = ?, scene_video = ?, eye_video = ? WHERE id = ?",
            updates,
        )
        await db.commit()
