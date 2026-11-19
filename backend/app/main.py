"""FastAPI application and MongoDB lifecycle."""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic_settings import BaseSettings, SettingsConfigDict
from pymongo import AsyncMongoClient

from app.identity import router
from app.locations import router as locations_router
from app.booking import router as booking_router
from app.tracking import router as tracking_router


class Settings(BaseSettings):
    """Read deployment settings from environment or the local env file."""
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    mongodb_uri: str = "mongodb://127.0.0.1:27017"
    mongodb_db: str = "ridenow"
    cors_origins: str = "http://localhost:3000"


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create an app with a single lifecycle-bound asynchronous Mongo client."""
    config = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        """Open the Mongo pool and install indexes before accepting requests."""
        client = AsyncMongoClient(config.mongodb_uri, serverSelectionTimeoutMS=5000)
        try:
            app.state.db = client.get_database(config.mongodb_db)
            await client.admin.command("ping")
            await app.state.db.sessions.create_index("expires_at", expireAfterSeconds=0)
            await app.state.db.challenges.create_index("expires_at", expireAfterSeconds=0)
            await app.state.db.saved_locations.create_index([('owner', 1), ('label_key', 1)], unique=True)
            await app.state.db.bookings.create_index('quote_id', unique=True)
            yield
        finally:
            await client.close()

    app = FastAPI(title="RideNow API", version="0.1.0", description="Simulated mobility identity API", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=[s.strip() for s in config.cors_origins.split(",") if s.strip()], allow_methods=["*"], allow_headers=["*"], allow_credentials=False)
    app.include_router(router)
    app.include_router(locations_router)
    app.include_router(booking_router)
    app.include_router(tracking_router)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        """Report process liveness."""
        return {"status": "ok"}

    return app


app = create_app()
