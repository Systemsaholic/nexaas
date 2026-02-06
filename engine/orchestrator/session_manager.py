"""Session manager for Claude Code subprocess sessions."""

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import AsyncIterator

from config import settings

logger = logging.getLogger(__name__)


@dataclass
class Session:
    """A single Claude Code session."""

    session_id: str
    agent: str
    workspace_dir: str
    process: asyncio.subprocess.Process | None = None


class SessionManager:
    """Manages Claude Code subprocess sessions."""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}

    def create_session(
        self,
        agent: str,
        session_id: str | None = None,
        workspace_dir: str | None = None,
    ) -> str:
        """Create a session record. Returns the session ID."""
        sid = session_id or uuid.uuid4().hex
        ws_dir = workspace_dir or str(settings.workspace_path)
        self._sessions[sid] = Session(
            session_id=sid,
            agent=agent,
            workspace_dir=ws_dir,
        )
        logger.info("Created session %s for agent %s (dir=%s)", sid, agent, ws_dir)
        return sid

    async def send_message(
        self, session_id: str, message: str
    ) -> AsyncIterator[str]:
        """Send a message to a Claude Code session.

        Spawns `claude --print --output-format stream-json --session-id X --directory Y`,
        pipes message via stdin, and yields stdout JSON chunks.
        """
        session = self._sessions.get(session_id)
        if not session:
            raise ValueError(f"Unknown session: {session_id}")

        claude_bin = settings.CLAUDE_CODE_PATH
        cmd = [
            claude_bin,
            "--print",
            "--output-format", "stream-json",
            "--session-id", session.session_id,
        ]

        logger.info("Spawning Claude Code: %s (cwd=%s)", " ".join(cmd), session.workspace_dir)

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=session.workspace_dir,
        )
        session.process = proc

        # Send the message via stdin and close
        if proc.stdin:
            proc.stdin.write(message.encode())
            await proc.stdin.drain()
            proc.stdin.close()

        # Stream stdout line by line
        if proc.stdout:
            async for line in proc.stdout:
                decoded = line.decode().strip()
                if not decoded:
                    continue
                yield decoded

        await proc.wait()

        if proc.returncode != 0 and proc.stderr:
            stderr = await proc.stderr.read()
            if stderr:
                logger.error(
                    "Claude Code session %s exited %d: %s",
                    session_id, proc.returncode, stderr.decode()[:500],
                )

        session.process = None

    async def destroy_session(self, session_id: str) -> None:
        """Terminate a session's subprocess if running."""
        session = self._sessions.pop(session_id, None)
        if session and session.process and session.process.returncode is None:
            session.process.terminate()
            try:
                await asyncio.wait_for(session.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                session.process.kill()
            logger.info("Destroyed session %s", session_id)

    async def shutdown(self) -> None:
        """Cleanup all sessions."""
        for sid in list(self._sessions):
            await self.destroy_session(sid)
        logger.info("Session manager shut down")


manager = SessionManager()
