"""Authentication API — register, login, current user."""

import uuid
from datetime import datetime, timezone

import bcrypt
import jwt
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from config import settings
from db.database import get_db

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def _create_token(user_id: str, username: str, role: str, company_id: str) -> str:
    return jwt.encode(
        {"sub": user_id, "username": username, "role": role, "company_id": company_id},
        settings.JWT_SECRET,
        algorithm="HS256",
    )


def _decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None


@router.post("/register")
async def register(request: Request):
    body = await request.json()
    company_name = body.get("company_name", "").strip()
    username = body.get("username", "").strip()
    password = body.get("password", "")

    if not username or not password:
        return JSONResponse(status_code=400, content={"detail": "Username and password required"})
    if len(password) < 6:
        return JSONResponse(status_code=400, content={"detail": "Password must be at least 6 characters"})

    db = await get_db()

    # Check if username already taken
    cur = await db.execute("SELECT id FROM users WHERE username = ?", (username,))
    if await cur.fetchone():
        return JSONResponse(status_code=409, content={"detail": "Username already taken"})

    # Check if any company exists
    cur = await db.execute("SELECT id, name FROM companies LIMIT 1")
    company_row = await cur.fetchone()

    if company_row:
        # Company exists — add user as member
        company_id = company_row[0]
        role = "member"
    else:
        # First registration — create company, user is admin
        if not company_name:
            return JSONResponse(status_code=400, content={"detail": "Company name required for first registration"})
        company_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        await db.execute(
            "INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)",
            (company_id, company_name, now),
        )
        role = "admin"

    user_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    password_hash = _hash_password(password)

    await db.execute(
        "INSERT INTO users (id, company_id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (user_id, company_id, username, password_hash, role, now),
    )
    await db.commit()

    token = _create_token(user_id, username, role, company_id)
    return {"token": token, "user": {"id": user_id, "username": username, "role": role, "company_id": company_id}}


@router.post("/login")
async def login(request: Request):
    body = await request.json()
    username = body.get("username", "").strip()
    password = body.get("password", "")

    if not username or not password:
        return JSONResponse(status_code=400, content={"detail": "Username and password required"})

    db = await get_db()
    cur = await db.execute(
        "SELECT u.id, u.username, u.password_hash, u.role, u.company_id, c.name "
        "FROM users u JOIN companies c ON u.company_id = c.id WHERE u.username = ?",
        (username,),
    )
    row = await cur.fetchone()
    if not row or not _verify_password(password, row[2]):
        return JSONResponse(status_code=401, content={"detail": "Invalid credentials"})

    user_id, uname, _, role, company_id, company_name = row
    token = _create_token(user_id, uname, role, company_id)
    return {
        "token": token,
        "user": {"id": user_id, "username": uname, "role": role, "company_id": company_id, "company": company_name},
    }


@router.get("/me")
async def me(request: Request):
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return JSONResponse(status_code=401, content={"detail": "Missing token"})

    payload = _decode_token(auth_header[7:])
    if not payload:
        return JSONResponse(status_code=401, content={"detail": "Invalid token"})

    db = await get_db()
    cur = await db.execute(
        "SELECT u.id, u.username, u.role, u.company_id, c.name "
        "FROM users u JOIN companies c ON u.company_id = c.id WHERE u.id = ?",
        (payload["sub"],),
    )
    row = await cur.fetchone()
    if not row:
        return JSONResponse(status_code=401, content={"detail": "User not found"})

    return {"id": row[0], "username": row[1], "role": row[2], "company_id": row[3], "company": row[4]}
