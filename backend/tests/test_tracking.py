"""Exercise tracking through HTTP against an isolated real MongoDB database."""
import asyncio
import os
import time
import uuid

import httpx
import pytest
from bson import ObjectId
from pymongo import AsyncMongoClient

from app.main import Settings, create_app

PICKUP = {'name': 'Cyber Towers', 'lat': 17.4504, 'lng': 78.3808}
DESTINATION = {'name': 'Airport', 'lat': 17.2403, 'lng': 78.4294}
PARCEL = {'package_type': 'medium_box', 'recipient_name': 'Test recipient', 'recipient_phone': '9876543210', 'instructions': 'Handle carefully', 'courier_vehicle': 'auto_car'}


@pytest.fixture
async def client():
    """Provide an isolated database and remove only that database afterward."""
    uri = os.getenv('TEST_MONGODB_URI', 'mongodb://127.0.0.1:27017')
    name = 'ridenow_tracking_test_' + uuid.uuid4().hex
    app = create_app(Settings(mongodb_uri=uri, mongodb_db=name))
    try:
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as http:
                yield http, app.state.db
    finally:
        cleanup = AsyncMongoClient(uri, serverSelectionTimeoutMS=3000)
        try:
            await cleanup.drop_database(name)
        finally:
            await cleanup.close()


async def login(http):
    """Create a guest session through the real identity API."""
    return {'Authorization': 'Bearer ' + (await http.post('/api/v1/identity/enter', json={'method': 'guest'})).json()['token']}


async def book(http, headers, vehicle='bike', parcel=None):
    """Create a quote and book it for the specified owner."""
    quote = (await http.post('/api/v1/booking/quotes', headers=headers, json={'pickup': PICKUP, 'destination': DESTINATION})).json()
    body = {'quote_id': quote['id'], 'vehicle': vehicle, 'payment': 'cash'}
    if parcel:
        body['parcel'] = parcel
    return await http.post('/api/v1/booking/rides', headers=headers, json=body)


async def arrive(db, booking_id):
    """Move persisted timestamps into the past without waiting for the simulation."""
    await db.bookings.update_one({'_id': ObjectId(booking_id)}, {'$set': {'tracking.matched_at': time.time() - 5, 'tracking.arrival_at': time.time() - 1}})


async def test_owner_matching_pin_and_completed_ride(client):
    """Persist one driver, enforce owner isolation and reject PIN replay."""
    http, db = client
    owner, stranger = await login(http), await login(http)
    booking = (await book(http, owner)).json()
    path = '/api/v1/tracking/' + booking['id']
    assert (await http.get(path)).status_code == 401
    assert (await http.get(path, headers=stranger)).status_code == 404
    initial_response = await http.get(path, headers=owner)
    assert initial_response.status_code == 200
    initial = initial_response.json()
    assert initial['state'] == 'matching' and 0 <= initial['arrival_seconds'] <= 60
    assert 0 < initial['matching_seconds'] <= 3
    stored = await db.bookings.find_one({'_id': ObjectId(booking['id'])})
    assert stored['tracking']['driver']['plate'].startswith('TS ')
    assert (await http.post(path + '/pin', headers=owner, json={'pin': stored['tracking']['pin']})).status_code == 409
    await arrive(db, booking['id'])
    arrived_response = await http.get(path, headers=owner)
    assert arrived_response.status_code == 200
    arrived = arrived_response.json()
    assert arrived['state'] == 'arrived' and arrived['pin'] == stored['tracking']['pin']
    assert arrived['driver'] == stored['tracking']['driver']
    started = await http.post(path + '/pin', headers=owner, json={'pin': arrived['pin']})
    assert started.status_code == 200 and started.json()['state'] == 'in_trip'
    assert (await http.post(path + '/pin', headers=owner, json={'pin': arrived['pin']})).status_code == 409
    await db.bookings.update_one({'_id': ObjectId(booking['id'])}, {'$set': {'tracking.started_at': time.time() - 31}})
    assert (await http.get(path, headers=owner)).json()['booking']['status'] == 'completed'
    assert (await http.post(path + '/cancel', headers=owner, json={'confirmed': True})).status_code == 409


async def test_wrong_pin_race_cancels_on_third_attempt(client):
    """Concurrent incorrect submissions cannot bypass the three-attempt limit."""
    http, db = client
    owner = await login(http)
    booking = (await book(http, owner)).json()
    path = '/api/v1/tracking/' + booking['id']
    await http.get(path, headers=owner)
    await arrive(db, booking['id'])
    pin = (await http.get(path, headers=owner)).json()['pin']
    wrong = '0000' if pin != '0000' else '0001'
    results = await asyncio.gather(*(http.post(path + '/pin', headers=owner, json={'pin': wrong}) for _ in range(3)))
    assert all(result.status_code == 200 for result in results)
    final = (await http.get(path, headers=owner)).json()
    assert final['state'] == 'cancelled' and final['attempts'] == 3 and final['booking']['status'] == 'cancelled'
    assert (await http.post(path + '/pin', headers=owner, json={'pin': pin})).status_code == 409


async def test_parcel_validation_lifecycle_and_confirmation(client):
    """Validate parcel input, enforce ordered stages and explicit cancellation."""
    http, db = client
    owner, stranger = await login(http), await login(http)
    assert (await book(http, owner, 'parcel')).status_code == 422
    assert (await book(http, owner, 'parcel', {**PARCEL, 'courier_vehicle': 'two_wheeler'})).status_code == 422
    assert (await book(http, owner, 'parcel', {**PARCEL, 'recipient_phone': 'bad'})).status_code == 422
    booking = (await book(http, owner, 'parcel', PARCEL)).json()
    assert booking['parcel'] == PARCEL
    path = '/api/v1/tracking/' + booking['id']
    await http.get(path, headers=owner)
    assert (await http.post(path + '/cancel', headers=owner, json={'confirmed': False})).status_code == 422
    assert (await http.post(path + '/cancel', headers=stranger, json={'confirmed': True})).status_code == 404
    assert (await http.post(path + '/parcel/deliver', headers=owner)).status_code == 409
    await arrive(db, booking['id'])
    arrived = (await http.get(path, headers=owner)).json()
    assert (await http.post(path + '/pin', headers=owner, json={'pin': 'xx'})).status_code == 422
    collected = await http.post(path + '/pin', headers=owner, json={'pin': arrived['pin']})
    assert collected.status_code == 200 and collected.json()['state'] == 'collected'
    transit = await http.post(path + '/parcel/transit', headers=owner)
    assert transit.status_code == 200 and transit.json()['state'] == 'transit'
    assert (await http.post(path + '/parcel/transit', headers=owner)).status_code == 409
    delivered = await http.post(path + '/parcel/deliver', headers=owner)
    assert delivered.status_code == 200 and delivered.json()['state'] == 'delivered' and delivered.json()['booking']['status'] == 'completed'
    reread = await http.get(path, headers=owner)
    assert reread.status_code == 200 and reread.json()['state'] == 'delivered'
    stored = await db.bookings.find_one({'_id': ObjectId(booking['id'])})
    assert stored['status'] == 'completed' and stored['tracking']['state'] == 'delivered'


async def test_confirmed_cancellation_is_terminal(client):
    """Require confirmation and prevent cancellation or starting from being replayed."""
    http, db = client
    owner = await login(http)
    booking = (await book(http, owner)).json()
    path = '/api/v1/tracking/' + booking['id']
    assert (await http.post(path + '/cancel', headers=owner, json={})).status_code == 422
    cancelled = await http.post(path + '/cancel', headers=owner, json={'confirmed': True})
    assert cancelled.status_code == 200 and cancelled.json()['state'] == 'cancelled'
    before = await db.bookings.find_one({'_id': ObjectId(booking['id'])})
    profile = await http.get('/api/v1/identity/profile', headers=owner)
    assert profile.status_code == 200
    assert before['owner'] == ObjectId(profile.json()['id'])
    assert before['status'] == 'cancelled' and before['tracking']['state'] == 'cancelled'
    assert (await http.post(path + '/cancel', headers=owner, json={'confirmed': True})).status_code == 409
    assert (await http.post(path + '/pin', headers=owner, json={'pin': '1234'})).status_code == 409
    assert await db.bookings.find_one({'_id': ObjectId(booking['id'])}) == before
    reread = await http.get(path, headers=owner)
    assert reread.status_code == 200 and reread.json()['state'] == 'cancelled'


async def test_tracking_rejects_missing_invalid_and_foreign_operations(client):
    http, db = client
    owner, stranger = await login(http), await login(http)
    created = await book(http, owner)
    assert created.status_code == 201
    path = '/api/v1/tracking/' + created.json()['id']
    for suffix, body in [('/pin', {}), ('/pin', {'pin': {'$ne': ''}}),
                         ('/pin', {'pin': '1' * 500}), ('/cancel', {}), ('/cancel', {'confirmed': False})]:
        assert (await http.post(path + suffix, headers=owner, json=body)).status_code == 422
    assert (await http.get('/api/v1/tracking/invalid', headers=owner)).status_code == 404
    assert (await http.get('/api/v1/tracking/' + str(ObjectId()), headers=owner)).status_code == 404
    assert (await http.post(path + '/pin', headers=stranger, json={'pin': '1234'})).status_code == 404
    assert (await http.post(path + '/parcel/transit', headers=stranger)).status_code == 404
    assert (await http.post(path + '/parcel/bogus', headers=owner)).status_code == 422
    stored = await db.bookings.find_one({'_id': ObjectId(created.json()['id'])})
    assert stored['status'] == 'confirmed' and 'tracking' not in stored
