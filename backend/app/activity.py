"""Owner-scoped history, simulated credits, feedback and reservations."""
import secrets
from datetime import datetime, timezone
from typing import Annotated, Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pymongo import ReturnDocument

from app.booking import QuoteInput, Vehicle, object_id, public_booking, public_quote
from app.core import current_user, database

router = APIRouter(prefix='/api/v1/activity', tags=['activity'])


class Feedback(BaseModel):
    """Validate simulated feedback without collecting payment details."""
    model_config = ConfigDict(extra='forbid')
    rating: int = Field(ge=1, le=5, strict=True)
    compliments: list[Literal['Clean vehicle', 'Polite driver', 'Great route navigation']] = Field(default_factory=list, max_length=3)
    tip_paise: int = Field(default=0, ge=0, le=1000000, strict=True)


class Funds(BaseModel):
    """Validate a positive amount of simulated credits in paise."""
    model_config = ConfigDict(extra='forbid')
    amount_paise: int = Field(gt=0, le=10000000, strict=True)


class Schedule(QuoteInput):
    """Capture a future simulated reservation with a route estimate."""
    kind: Literal['reserve', 'hourly']
    scheduled_at: datetime
    vehicle: Vehicle

    @field_validator('scheduled_at')
    @classmethod
    def future_time(cls, value: datetime) -> datetime:
        """Require an unambiguous future instant."""
        if value.tzinfo is None or value.utcoffset() is None or value <= datetime.now(timezone.utc):
            raise ValueError('Choose a future time with a timezone')
        return value.astimezone(timezone.utc)


def public_schedule(doc: dict) -> dict:
    """Serialize a reservation without disclosing its owner."""
    return {'id': str(doc['_id']), 'kind': doc['kind'], 'scheduled_at': doc['scheduled_at'].replace(tzinfo=timezone.utc).isoformat(), 'pickup': doc['pickup'], 'destination': doc['destination'], 'vehicle': doc['vehicle'], 'distance_km': doc['distance_km'], 'surge_multiplier': doc['surge_multiplier'], 'status': doc['status']}


def schedule_estimate(payload: Schedule) -> dict:
    """Calculate a reservation estimate without creating a standalone quote."""
    return public_quote({'_id': ObjectId(), 'pickup': payload.pickup.model_dump(),
                         'destination': payload.destination.model_dump(),
                         'surge': secrets.randbelow(3) == 0})


class ActivityRepository:
    """Read and mutate persisted activity within a rider's scope."""
    def __init__(self, db, owner):
        """Use the application pool and authenticated owner."""
        self.db, self.owner = db, owner

    async def completed(self, booking_id: str) -> dict:
        """Return an owned completed booking or a non-disclosing error."""
        doc = await self.db.bookings.find_one({'_id': object_id(booking_id), 'owner': self.owner, 'status': 'completed'})
        if not doc:
            raise HTTPException(404, 'Completed journey not found')
        return doc

    async def schedule(self, schedule_id: str, fields: dict) -> dict:
        """Change a future reservation atomically, never a terminal one."""
        key = {'_id': object_id(schedule_id), 'owner': self.owner}
        doc = await self.db.schedules.find_one_and_update({**key, 'status': 'scheduled', 'scheduled_at': {'$gt': datetime.now(timezone.utc)}}, {'$set': fields}, return_document=ReturnDocument.AFTER)
        if doc:
            return doc
        if not await self.db.schedules.find_one(key):
            raise HTTPException(404, 'Reservation not found')
        raise HTTPException(409, 'Only future scheduled reservations can be changed')


@router.get('/history')
async def history(request: Request, user: Annotated[dict, Depends(current_user)], limit: Annotated[int, Query(ge=1, le=100)] = 50, offset: Annotated[int, Query(ge=0)] = 0) -> dict:
    """List completed journeys in reverse creation order."""
    collection = database(request).bookings
    query = {'owner': user['_id'], 'status': 'completed'}
    docs = await collection.find(query).sort('_id', -1).skip(offset).limit(limit).to_list(length=limit)
    return {'items': [{**public_booking(doc), 'feedback': doc.get('feedback')} for doc in docs], 'total': await collection.count_documents(query)}


@router.get('/history/{booking_id}')
async def receipt(booking_id: str, request: Request, user: Annotated[dict, Depends(current_user)]) -> dict:
    """Return the original fare snapshot, not a newly calculated quote."""
    doc = await ActivityRepository(database(request), user['_id']).completed(booking_id)
    vehicle = doc['vehicle']
    return {**public_booking(doc), 'feedback': doc.get('feedback'), 'breakdown': {'base_and_distance': vehicle['base_fare'], 'tier_fee': vehicle['tier_fee'], 'time': 0, 'surge': round(vehicle['fare'] - vehicle['original_fare'], 2), 'discount': 0, 'total': vehicle['fare']}}


@router.put('/history/{booking_id}/feedback')
async def feedback(booking_id: str, payload: Feedback, request: Request, user: Annotated[dict, Depends(current_user)]) -> dict:
    """Save feedback only on an owned completed journey."""
    repo = ActivityRepository(database(request), user['_id'])
    await repo.completed(booking_id)
    doc = await repo.db.bookings.find_one_and_update({'_id': object_id(booking_id), 'owner': user['_id'], 'status': 'completed'}, {'$set': {'feedback': payload.model_dump()}}, return_document=ReturnDocument.AFTER)
    if not doc:
        raise HTTPException(409, 'Journey changed; refresh and retry')
    return doc['feedback']


@router.get('/wallet')
async def wallet(user: Annotated[dict, Depends(current_user)]) -> dict:
    """Read simulated credits from the authenticated profile."""
    return {'balance_paise': user.get('wallet_paise', 0)}


@router.post('/wallet/funds')
async def add_funds(payload: Funds, request: Request, user: Annotated[dict, Depends(current_user)]) -> dict:
    """Increment credits atomically; no real payment occurs."""
    doc = await database(request).profiles.find_one_and_update({'_id': user['_id']}, {'$inc': {'wallet_paise': payload.amount_paise}}, return_document=ReturnDocument.AFTER)
    if doc is None:
        raise HTTPException(404, 'Profile not found')
    return {'balance_paise': doc['wallet_paise']}


@router.get('/schedules')
async def schedules(request: Request, user: Annotated[dict, Depends(current_user)], limit: Annotated[int, Query(ge=1, le=100)] = 50, offset: Annotated[int, Query(ge=0)] = 0) -> dict:
    """List only future scheduled reservations, with a matching total."""
    collection = database(request).schedules
    query = {'owner': user['_id'], 'status': 'scheduled', 'scheduled_at': {'$gt': datetime.now(timezone.utc)}}
    docs = await collection.find(query).sort('scheduled_at', 1).skip(offset).limit(limit).to_list(length=limit)
    return {'items': [public_schedule(doc) for doc in docs], 'total': await collection.count_documents(query)}


@router.post('/schedules', status_code=201)
async def create_schedule(payload: Schedule, request: Request, user: Annotated[dict, Depends(current_user)]) -> dict:
    """Save an estimate without dispatch, payment, or an invented hourly tariff."""
    db = database(request)
    quote = schedule_estimate(payload)
    doc = {'owner': user['_id'], 'kind': payload.kind, 'scheduled_at': payload.scheduled_at, 'pickup': quote['pickup'], 'destination': quote['destination'], 'vehicle': next(v for v in quote['vehicles'] if v['id'] == payload.vehicle), 'distance_km': quote['distance_km'], 'surge_multiplier': quote['surge_multiplier'], 'status': 'scheduled'}
    result = await db.schedules.insert_one(doc)
    doc['_id'] = result.inserted_id
    return public_schedule(doc)


@router.put('/schedules/{schedule_id}')
async def edit_schedule(schedule_id: str, payload: Schedule, request: Request, user: Annotated[dict, Depends(current_user)]) -> dict:
    """Update a future reservation and refresh its simulated estimate."""
    db = database(request)
    repo = ActivityRepository(db, user['_id'])
    existing = await db.schedules.find_one({'_id': object_id(schedule_id), 'owner': user['_id']})
    if not existing:
        raise HTTPException(404, 'Reservation not found')
    quote = schedule_estimate(payload)
    fields = {'kind': payload.kind, 'scheduled_at': payload.scheduled_at, 'pickup': quote['pickup'], 'destination': quote['destination'], 'vehicle': next(v for v in quote['vehicles'] if v['id'] == payload.vehicle), 'distance_km': quote['distance_km'], 'surge_multiplier': quote['surge_multiplier']}
    return public_schedule(await repo.schedule(schedule_id, fields))


@router.post('/schedules/{schedule_id}/cancel')
async def cancel_schedule(schedule_id: str, request: Request, user: Annotated[dict, Depends(current_user)]) -> dict:
    """Cancel a future reservation without charging a fee."""
    return public_schedule(await ActivityRepository(database(request), user['_id']).schedule(schedule_id, {'status': 'cancelled'}))
