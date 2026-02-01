"""FastAPI application entry point."""

import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown lifecycle."""
    logger.info("Starting AI Mission Control Engine on %s:%d", settings.HOST, settings.PORT)

    # Initialize database
    from db.database import init_db, close_db
    await init_db()

    # Start engine and workers
    from orchestrator.event_engine import start as start_engine, stop as stop_engine
    from orchestrator.workers import start as start_workers, stop as stop_workers
    from orchestrator.ops_monitor import start as start_ops, stop as stop_ops
    start_engine()
    start_workers()
    start_ops()

    yield

    # Shutdown
    logger.info("Shutting down...")
    from orchestrator.session_manager import manager
    await manager.shutdown()
    await stop_ops()
    await stop_engine()
    await stop_workers()
    await close_db()


app = FastAPI(
    title="AI Mission Control Engine",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Bearer token auth middleware
@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    # Skip auth for health check, OPTIONS, and auth endpoints
    if (
        request.url.path == "/api/health"
        or request.method == "OPTIONS"
        or request.url.path.startswith("/api/auth/")
    ):
        return await call_next(request)

    if settings.API_KEY:
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return JSONResponse(status_code=401, content={"detail": "Missing bearer token"})
        token = auth_header[7:]
        if token != settings.API_KEY:
            return JSONResponse(status_code=403, content={"detail": "Invalid API key"})

    return await call_next(request)


# Health endpoint
@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "0.1.0"}


# Mount routers
from api.workspace import router as workspace_router
from api.agents import router as agents_router
from api.registries import router as registries_router
from api.events import router as events_router
from api.queue import router as queue_router
from api.chat import router as chat_router
from api.usage import router as usage_router
from api.ops import router as ops_router
from api.skills import router as skills_router
from api.auth import router as auth_router

app.include_router(workspace_router)
app.include_router(agents_router)
app.include_router(registries_router)
app.include_router(events_router)
app.include_router(queue_router)
app.include_router(chat_router)
app.include_router(usage_router)
app.include_router(ops_router)
app.include_router(skills_router)
app.include_router(auth_router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "server:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=False,
    )
