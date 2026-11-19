"""Persist owner-scoped simulated matching and atomic journey transitions."""
import math
import secrets
import time
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from pymongo import ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase

from app.booking import object_id, public_booking
from app.core import current_user, database

router = APIRouter(prefix='/api/v1/tracking', tags=['tracking'])


class PinInput(BaseModel):
    """Validate a four-digit simulated safety PIN."""
    model_config = ConfigDict(extra='forbid')
    pin: str = Field(pattern=r'^[0-9]{4}$')


class CancelInput(BaseModel):
    """Require explicit confirmation before cancellation."""
    model_config = ConfigDict(extra='forbid')
    confirmed: Literal[True]


def assignment(vehicle: str) -> dict:
    """Generate one simulated driver and pickup schedule per booking."""
    now = time.time()
    matched = now + 2 + secrets.randbelow(1001) / 1000
    arrival_seconds = secrets.randbelow(61)
    models = {'bike': 'Honda Shine', 'auto': 'Bajaj Auto', 'ubergo': 'Maruti Swift',
              'premier': 'Honda City', 'uberxl': 'Toyota Innova', 'black': 'Mercedes E-Class',
              'parcel': 'Courier vehicle'}
    return {'state': 'matching', 'version': 0, 'matched_at': matched,
            'arrival_at': matched + arrival_seconds, 'arrival_seconds': arrival_seconds,
            'pin': f'{secrets.randbelow(10000):04d}', 'attempts': 0,
            'driver': {'name': secrets.choice(['Rajesh Reddy', 'Mohammed Ismail', 'Suresh Varma', 'Karthik Rao']),
                       'rating': round(4.8 + secrets.randbelow(20) / 100, 2),
                       'trips': 1500 + secrets.randbelow(3000), 'model': models[vehicle],
                       'plate': f'TS {secrets.choice(["07", "09"])} {secrets.choice(["UA", "EZ", "AB"])} {1000 + secrets.randbelow(9000)}'}}


class TrackingRepository:
    """Use single-document compare-and-set operations for journey state."""
    def __init__(self, db: AsyncDatabase, owner: object, booking_id: str) -> None:
        """Scope every lookup and update to the authenticated owner."""
        self.collection = db.bookings
        self.key = {'_id': object_id(booking_id), 'owner': owner}

    async def get(self) -> dict:
        """Retrieve a booking, lazily assigning a driver once."""
        doc = await self.collection.find_one(self.key)
        if not doc:
            raise HTTPException(404, 'Booking not found')
        if 'tracking' not in doc and doc['status'] == 'confirmed':
            await self.collection.update_one({**self.key, 'tracking': {'$exists': False}, 'status': 'confirmed'},
                                             {'$set': {'tracking': assignment(doc['vehicle']['id'])}})
            doc = await self.collection.find_one(self.key)
        return doc

    async def change(self, doc: dict, fields: dict) -> dict | None:
        """Update only the exact version read, preventing concurrent replays."""
        return await self.collection.find_one_and_update(
            {**self.key, 'tracking.version': doc['tracking']['version']},
            {'$set': fields, '$inc': {'tracking.version': 1}}, return_document=ReturnDocument.AFTER)

    async def refresh(self) -> dict:
        """Advance elapsed simulated phases without overwriting a concurrent action."""
        while True:
            doc = await self.get()
            tracking = doc.get('tracking')
            if not tracking:
                return doc
            now, state = time.time(), tracking['state']
            next_state = None
            if state == 'matching' and now >= tracking['matched_at']:
                next_state = 'assigned' if doc['vehicle']['id'] == 'parcel' else 'on_way'
            elif state == 'assigned' and now >= min(tracking['matched_at'] + 1, tracking['arrival_at']):
                next_state = 'on_way'
            elif state == 'on_way' and now >= tracking['arrival_at']:
                next_state = 'arrived'
            elif state == 'in_trip' and now >= tracking['started_at'] + 30:
                updated = await self.change(doc, {'tracking.state': 'completed', 'status': 'completed'})
                if updated:
                    return updated
                continue
            if not next_state:
                return doc
            if await self.change(doc, {'tracking.state': next_state}):
                continue


def public_tracking(doc: dict) -> dict:
    """Return owner-visible simulation data and bounded countdowns."""
    t = doc['tracking']
    now = time.time()
    return {'booking': public_booking(doc), 'state': t['state'],
            'driver': t['driver'] if t['state'] != 'matching' else None,
            'pin': t['pin'] if t['state'] != 'matching' else None,
            'attempts': t['attempts'], 'arrival_seconds': t['arrival_seconds'],
            'seconds_to_arrival': max(0, math.ceil(t['arrival_at'] - now)),
            'matching_seconds': max(0, t['matched_at'] - now),
            'progress': min(1, max(0, (now - t.get('started_at', now)) / 30)) if t['state'] in ('in_trip', 'transit') else (1 if t['state'] in ('completed', 'delivered') else 0)}


async def current(repo: TrackingRepository) -> dict:
    """Return tracking state or reject terminal legacy bookings."""
    doc = await repo.refresh()
    if 'tracking' not in doc:
        raise HTTPException(409, 'Tracking unavailable for this booking')
    return doc


@router.get('/{booking_id}')
async def get_tracking(booking_id: str, request: Request, user: Annotated[dict, Depends(current_user)]) -> dict:
    """Initialize and read a rider's persisted simulation."""
    return public_tracking(await current(TrackingRepository(database(request), user['_id'], booking_id)))


@router.post('/{booking_id}/pin')
async def verify_pin(booking_id: str, payload: PinInput, request: Request, user: Annotated[dict, Depends(current_user)]) -> dict:
    """Start only on an arrived booking; the third wrong PIN cancels atomically."""
    repo = TrackingRepository(database(request), user['_id'], booking_id)
    while True:
        doc = await current(repo)
        t = doc['tracking']
        if t['state'] != 'arrived':
            raise HTTPException(409, 'PIN can only be checked on arrival')
        if secrets.compare_digest(payload.pin, t['pin']):
            state = 'collected' if doc['vehicle']['id'] == 'parcel' else 'in_trip'
            fields = {'tracking.state': state, 'tracking.started_at': time.time(), 'status': 'in_progress'}
        else:
            attempts = t['attempts'] + 1
            fields = {'tracking.attempts': attempts}
            if attempts >= 3:
                fields.update({'tracking.state': 'cancelled', 'status': 'cancelled'})
        updated = await repo.change(doc, fields)
        if updated:
            return public_tracking(updated)


@router.post('/{booking_id}/cancel')
async def cancel(booking_id: str, payload: CancelInput, request: Request, user: Annotated[dict, Depends(current_user)]) -> dict:
    """Cancel an active simulation only after explicit confirmation."""
    repo = TrackingRepository(database(request), user['_id'], booking_id)
    while True:
        doc = await current(repo)
        if doc['tracking']['state'] in ('completed', 'delivered', 'cancelled'):
            raise HTTPException(409, 'Journey is already finished')
        updated = await repo.change(doc, {'tracking.state': 'cancelled', 'status': 'cancelled'})
        if updated:
            return public_tracking(updated)


@router.post('/{booking_id}/parcel/{action}')
async def advance_parcel(booking_id: str, action: Literal['transit', 'deliver'], request: Request, user: Annotated[dict, Depends(current_user)]) -> dict:
    """Advance a parcel one explicitly requested stage, rejecting replay."""
    repo = TrackingRepository(database(request), user['_id'], booking_id)
    doc = await current(repo)
    expected, target = ('collected', 'transit') if action == 'transit' else ('transit', 'delivered')
    if doc['vehicle']['id'] != 'parcel' or doc['tracking']['state'] != expected:
        raise HTTPException(409, 'Invalid parcel transition')
    fields = {'tracking.state': target}
    if target == 'transit':
        fields['tracking.started_at'] = time.time()
    if target == 'delivered':
        fields['status'] = 'completed'
    updated = await repo.change(doc, fields)
    if not updated:
        raise HTTPException(409, 'Journey changed; refresh and retry')
    return public_tracking(updated)
