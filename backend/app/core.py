"""Shared Mongo-backed session and identity data access."""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pymongo import ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase

bearer = HTTPBearer(auto_error=False)


def digest(token: str) -> str:
    """Hash a high-entropy token before storing it."""
    return hashlib.sha256(token.encode()).hexdigest()


def database(request: Request) -> AsyncDatabase:
    """Get the database attached to the running application."""
    return request.app.state.db


class IdentityRepository:
    """Persist anonymous demo profiles, challenges and sessions."""

    def __init__(self, db: AsyncDatabase) -> None:
        """Use the application's pooled database."""
        self.db = db

    async def challenge(self, phone: str) -> str:
        """Create an expiring single-use simulated challenge."""
        token = secrets.token_urlsafe(32)
        await self.db.challenges.insert_one({"_id": digest(token), "phone": phone, "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5)})
        return token

    async def consume_challenge(self, token: str) -> dict[str, Any] | None:
        """Atomically consume a challenge only while it is valid."""
        return await self.db.challenges.find_one_and_delete({"_id": digest(token), "expires_at": {"$gt": datetime.now(timezone.utc)}})

    async def create_session(self, method: str, phone: str = "") -> tuple[str, dict[str, Any]]:
        """Create an independent demo profile and its bearer session."""
        profile = {"first_name": "Guest" if method == "guest" else "Rider", "last_name": "", "phone": phone, "email": "", "photo": "", "rating": 4.92, "method": method}
        inserted = await self.db.profiles.insert_one(profile)
        token = secrets.token_urlsafe(32)
        await self.db.sessions.insert_one({"_id": digest(token), "user_id": inserted.inserted_id, "expires_at": datetime.now(timezone.utc) + timedelta(days=30)})
        return token, profile

    async def profile_for_token(self, token: str) -> dict[str, Any] | None:
        """Resolve an unexpired bearer token to its own profile."""
        session = await self.db.sessions.find_one({"_id": digest(token), "expires_at": {"$gt": datetime.now(timezone.utc)}})
        return await self.db.profiles.find_one({"_id": session["user_id"]}) if session else None

    async def update_profile(self, user_id: Any, fields: dict[str, Any]) -> dict[str, Any] | None:
        """Update only fields belonging to the authenticated profile."""
        return await self.db.profiles.find_one_and_update({"_id": user_id}, {"$set": fields}, return_document=ReturnDocument.AFTER)

    async def revoke(self, token: str) -> None:
        """Revoke one bearer session."""
        await self.db.sessions.delete_one({"_id": digest(token)})


async def current_user(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> dict[str, Any]:
    """Require a valid unexpired bearer session."""
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Bearer session required", headers={"WWW-Authenticate": "Bearer"})
    user = await IdentityRepository(database(request)).profile_for_token(credentials.credentials)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid or expired session", headers={"WWW-Authenticate": "Bearer"})
    return user
