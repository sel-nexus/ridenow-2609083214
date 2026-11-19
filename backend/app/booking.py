"""Owner-scoped simulated fare quotes and bookings for Hyderabad."""
import math
import secrets
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Annotated, Literal

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, model_validator
from pymongo.errors import DuplicateKeyError
from pymongo.asynchronous.database import AsyncDatabase

from app.core import current_user, database
from app.locations import Location

router = APIRouter(prefix='/api/v1/booking', tags=['booking'])

# Fixed tier supplements are disclosed separately from the common distance fare.
TIERS = {
    'bike': ('Bike', 1, 0, 3),
    'auto': ('Auto', 3, 10, 4),
    'ubergo': ('UberGo', 4, 25, 5),
    'premier': ('Premier', 4, 45, 6),
    'uberxl': ('UberXL', 6, 70, 8),
    'black': ('Uber Black', 4, 100, 10),
    'parcel': ('Parcel', None, 15, 5),
}
Vehicle = Literal['bike', 'auto', 'ubergo', 'premier', 'uberxl', 'black', 'parcel']
Payment = Literal['cash', 'card_visa', 'card_mastercard', 'card_rupay', 'card_amex', 'upi_google_pay', 'upi_phonepe', 'upi_paytm', 'upi_custom', 'paytm_wallet', 'amazon_pay', 'net_sbi', 'net_hdfc', 'net_icici', 'net_axis', 'ridenow_wallet']


class QuoteInput(BaseModel):
    """Validate a Hyderabad route before estimating it."""
    model_config = ConfigDict(extra='forbid')
    pickup: Location
    destination: Location

    @model_validator(mode='after')
    def different_points(self) -> 'QuoteInput':
        """Reject a zero-length route."""
        if self.pickup.lat == self.destination.lat and self.pickup.lng == self.destination.lng:
            raise ValueError('Pickup and destination must differ')
        return self


class BookingInput(BaseModel):
    """Accept only a server quote reference and validated selections."""
    model_config = ConfigDict(extra='forbid')
    quote_id: str
    vehicle: Vehicle
    payment: Payment


def road_distance(pickup: Location, destination: Location) -> float:
    """Estimate road kilometres as 1.4 times great-circle distance."""
    lat1, lat2 = math.radians(pickup.lat), math.radians(destination.lat)
    dlat = lat2 - lat1
    dlng = math.radians(destination.lng - pickup.lng)
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return round(6371 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a)) * 1.4, 2)


def money(value: Decimal) -> float:
    """Round a rupee amount to the nearest paise."""
    return float(value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))


def prices(distance: float, surge: bool) -> list[dict]:
    """Compute all tier fares from the rounded displayed road estimate."""
    base = Decimal('30') + max(Decimal('0'), Decimal(str(distance)) - Decimal('3')) * Decimal('5')
    multiplier = Decimal('1.1') if surge else Decimal('1')
    return [dict(id=key, name=name, seats=seats, tier_fee=fee, eta_minutes=eta,
                 base_fare=money(base), original_fare=money(base + Decimal(fee)),
                 fare=money((base + Decimal(fee)) * multiplier))
            for key, (name, seats, fee, eta) in TIERS.items()]


class BookingRepository:
    """Persist and retrieve quotes and bookings within their owner scope."""
    def __init__(self, db: AsyncDatabase) -> None:
        """Use the existing application database pool."""
        self.db = db

    async def create_quote(self, owner: ObjectId, payload: QuoteInput) -> dict:
        """Persist the route and simulated demand decision."""
        doc = {'owner': owner, **payload.model_dump(), 'surge': secrets.randbelow(3) == 0,
               'created_at': datetime.now(timezone.utc)}
        result = await self.db.quotes.insert_one(doc)
        doc['_id'] = result.inserted_id
        return doc

    async def quote(self, owner: ObjectId, quote_id: ObjectId) -> dict | None:
        """Find a quote without exposing another rider's data."""
        return await self.db.quotes.find_one({'_id': quote_id, 'owner': owner})

    async def create_booking(self, doc: dict) -> dict:
        """Persist a booking, preventing multiple bookings from one quote."""
        result = await self.db.bookings.insert_one(doc)
        doc['_id'] = result.inserted_id
        return doc

    async def booking(self, owner: ObjectId, booking_id: ObjectId) -> dict | None:
        """Find a booking without exposing another rider's data."""
        return await self.db.bookings.find_one({'_id': booking_id, 'owner': owner})


def public_quote(doc: dict) -> dict:
    """Recalculate and serialize a quote without owner information."""
    pickup, destination = Location(**doc['pickup']), Location(**doc['destination'])
    distance = road_distance(pickup, destination)
    return {'id': str(doc['_id']), 'pickup': doc['pickup'], 'destination': doc['destination'],
            'distance_km': distance, 'surge_multiplier': 1.1 if doc['surge'] else 1.0,
            'vehicles': prices(distance, doc['surge'])}


def public_booking(doc: dict) -> dict:
    """Expose the persisted booking and tracking handoff data."""
    return {'id': str(doc['_id']), 'quote_id': str(doc['quote_id']), 'pickup': doc['pickup'],
            'destination': doc['destination'], 'distance_km': doc['distance_km'],
            'surge_multiplier': doc['surge_multiplier'], 'vehicle': doc['vehicle'],
            'payment': doc['payment'], 'status': doc['status'],
            'created_at': doc['created_at'].replace(tzinfo=timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')}


def object_id(value: str) -> ObjectId:
    """Return an object ID or a non-disclosing not-found error."""
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=404, detail='Not found')


@router.post('/quotes', status_code=201)
async def create_quote(payload: QuoteInput, request: Request, user: Annotated[dict, Depends(current_user)]) -> dict:
    """Create a simulated demand quote for the current rider."""
    return public_quote(await BookingRepository(database(request)).create_quote(user['_id'], payload))


@router.post('/rides', status_code=201)
async def create_ride(payload: BookingInput, request: Request, user: Annotated[dict, Depends(current_user)]) -> dict:
    """Recompute the selected fare and save a simulated booking."""
    repo = BookingRepository(database(request))
    quote = await repo.quote(user['_id'], object_id(payload.quote_id))
    if quote is None:
        raise HTTPException(status_code=404, detail='Quote not found')
    calculated = public_quote(quote)
    vehicle = next(item for item in calculated['vehicles'] if item['id'] == payload.vehicle)
    doc = {'owner': user['_id'], 'quote_id': quote['_id'], 'pickup': calculated['pickup'],
           'destination': calculated['destination'], 'distance_km': calculated['distance_km'],
           'surge_multiplier': calculated['surge_multiplier'], 'vehicle': vehicle,
           'payment': payload.payment, 'status': 'confirmed', 'created_at': datetime.now(timezone.utc)}
    try:
        return public_booking(await repo.create_booking(doc))
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail='Quote already booked')


@router.get('/rides/{booking_id}')
async def get_ride(booking_id: str, request: Request, user: Annotated[dict, Depends(current_user)]) -> dict:
    """Retrieve an owned booking for the future tracking flow."""
    doc = await BookingRepository(database(request)).booking(user['_id'], object_id(booking_id))
    if doc is None:
        raise HTTPException(status_code=404, detail='Booking not found')
    return public_booking(doc)
