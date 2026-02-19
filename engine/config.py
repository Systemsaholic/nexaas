"""Engine configuration loaded from environment variables."""

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()


class Settings:
    """Application settings sourced from environment variables."""

    WORKSPACE_ROOT: str = os.getenv("WORKSPACE_ROOT", ".")
    API_KEY: str = os.getenv("API_KEY", "")
    DATABASE_PATH: str = os.getenv("DATABASE_PATH", "data/nexaas.db")
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "8400"))
    ENGINE_TICK_SECONDS: int = int(os.getenv("ENGINE_TICK_SECONDS", "30"))
    WORKER_POOL_SIZE: int = int(os.getenv("WORKER_POOL_SIZE", "1"))
    CORS_ORIGINS: list[str] = [
        o.strip()
        for o in os.getenv("CORS_ORIGINS", "*").split(",")
        if o.strip()
    ]

    # Framework & Claude Code
    FRAMEWORK_ROOT: str = os.getenv(
        "FRAMEWORK_ROOT",
        str(Path(__file__).resolve().parent.parent / "framework"),
    )
    CLAUDE_CODE_PATH: str = os.getenv("CLAUDE_CODE_PATH", "claude")
    CLAUDE_SKIP_PERMISSIONS: bool = os.getenv("CLAUDE_SKIP_PERMISSIONS", "true").lower() in ("true", "1", "yes")

    # Auth
    JWT_SECRET: str = os.getenv("JWT_SECRET", "change-me-in-production")

    # Ops monitor
    OPS_MONITOR_ENABLED: bool = os.getenv("OPS_MONITOR_ENABLED", "true").lower() in ("true", "1", "yes")
    OPS_MONITOR_INTERVAL_S: int = int(os.getenv("OPS_MONITOR_INTERVAL_S", "30"))
    OPS_WEBHOOK_URL: str | None = os.getenv("OPS_WEBHOOK_URL") or None
    OPS_STALE_JOB_TIMEOUT_M: int = int(os.getenv("OPS_STALE_JOB_TIMEOUT_M", "10"))
    OPS_MAX_FAILED_JOBS_HOUR: int = int(os.getenv("OPS_MAX_FAILED_JOBS_HOUR", "10"))

    @property
    def workspace_path(self) -> Path:
        return Path(self.WORKSPACE_ROOT).resolve()

    @property
    def framework_path(self) -> Path:
        return Path(self.FRAMEWORK_ROOT).resolve()

    @property
    def database_path(self) -> Path:
        return Path(self.DATABASE_PATH)

    def validate(self) -> None:
        if not self.API_KEY:
            raise ValueError("API_KEY environment variable is required")


settings = Settings()
