"""Simulated identity entry and owner-scoped profile routes."""
import base64
import binascii
import re
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.core import IdentityRepository, bearer, current_user, database

router = APIRouter(prefix="/api/v1/identity", tags=["identity"])


class PhoneRequest(BaseModel):
    """Validate an international phone number."""
    model_config = ConfigDict(extra="forbid")
    phone: str = Field(pattern=r"^\+[1-9][0-9]{7,14}$")


class VerifyRequest(BaseModel):
    """Validate a simulated OTP attempt."""
    model_config = ConfigDict(extra="forbid")
    challenge: str = Field(min_length=20, max_length=128)
    otp: str = Field(pattern=r"^(?:[0-9]{4}|[0-9]{6})$")


class FastEntry(BaseModel):
    """Select a demo entry method."""
    model_config = ConfigDict(extra="forbid")
    method: Literal["google", "apple", "guest"]


class ProfileUpdate(BaseModel):
    """Validate editable personal details without accepting owner identifiers."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    first_name: str = Field(min_length=1, max_length=60)
    last_name: str = Field(default="", max_length=60)
    phone: str = Field(default="", max_length=16)
    email: EmailStr | Literal[""] = ""
    photo: str = Field(default="", max_length=200000)

    @field_validator("phone")
    @classmethod
    def check_phone(cls, value: str) -> str:
        """Accept an empty or international phone number."""
        if value and not re.fullmatch(r"\+[1-9][0-9]{7,14}", value):
            raise ValueError("Use an international number, for example +919876543210")
        return value

    @field_validator("photo")
    @classmethod
    def check_photo(cls, value: str) -> str:
        """Limit photos to valid small base64 raster data URLs."""
        if value:
            match = re.fullmatch(r"data:image/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})", value)
            if not match:
                raise ValueError("Use a PNG, JPEG or WebP photo")
            try:
                base64.b64decode(match.group(1), validate=True)
            except (ValueError, binascii.Error) as exc:
                raise ValueError("Invalid photo data") from exc
        return value


class Profile(BaseModel):
    """Expose only public profile fields."""
    id: str
    first_name: str
    last_name: str
    phone: str
    email: str
    photo: str
    rating: float
    method: str


def public_profile(doc: dict) -> Profile:
    """Map a Mongo document to its public representation."""
    return Profile(id=str(doc["_id"]), **{key: doc[key] for key in ("first_name", "last_name", "phone", "email", "photo", "rating", "method")})


class SessionResponse(BaseModel):
    """Return a bearer token once with the profile it owns."""
    token: str
    profile: Profile


@router.post("/phone/start")
async def start_phone(payload: PhoneRequest, request: Request) -> dict[str, str]:
    """Create a simulated challenge; no SMS is sent."""
    challenge = await IdentityRepository(database(request)).challenge(payload.phone)
    return {"challenge": challenge, "message": "Simulation only: no SMS sent. Enter any 4 or 6 digits."}


@router.post("/phone/verify", response_model=SessionResponse)
async def verify_phone(payload: VerifyRequest, request: Request) -> SessionResponse:
    """Consume a challenge and issue a new isolated demo session."""
    repo = IdentityRepository(database(request))
    challenge = await repo.consume_challenge(payload.challenge)
    if not challenge:
        raise HTTPException(status_code=401, detail="Challenge expired or already used")
    token, profile = await repo.create_session("phone", challenge["phone"])
    return SessionResponse(token=token, profile=public_profile(profile))


@router.post("/enter", response_model=SessionResponse)
async def fast_entry(payload: FastEntry, request: Request) -> SessionResponse:
    """Create a demo session without contacting a social provider."""
    token, profile = await IdentityRepository(database(request)).create_session(payload.method)
    return SessionResponse(token=token, profile=public_profile(profile))


@router.get("/profile", response_model=Profile)
async def get_profile(user: Annotated[dict, Depends(current_user)]) -> Profile:
    """Read the profile owned by the bearer session."""
    return public_profile(user)


@router.put("/profile", response_model=Profile)
async def update_profile(payload: ProfileUpdate, request: Request, user: Annotated[dict, Depends(current_user)]) -> Profile:
    """Update the profile owned by the bearer session."""
    updated = await IdentityRepository(database(request)).update_profile(user["_id"], payload.model_dump())
    if updated is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    return public_profile(updated)


@router.post("/logout", status_code=204)
async def logout(request: Request, user: Annotated[dict, Depends(current_user)], credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)]) -> None:
    """Revoke the current session without deleting the profile."""
    await IdentityRepository(database(request)).revoke(credentials.credentials)
