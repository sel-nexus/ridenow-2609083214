"""Cross-feature journeys through the real API and an isolated MongoDB."""
import asyncio
import os
import time
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from bson import ObjectId
from pymongo import AsyncMongoClient

from app.main import Settings, create_app

PICKUP = {'name': 'Cyber Towers', 'lat': 17.4504, 'lng': 78.3808}
DESTINATION = {'name': 'Airport', 'lat': 17.2403, 'lng': 78.4294}
PARCEL = {'package_type': 'medium_box', 'recipient_name': 'Test recipient',
          'recipient_phone': '9876543210', 'instructions': 'Handle carefully',
          'courier_vehicle': 'auto_car'}


@pytest.fixture
async def client():
    """Run the real application against a uniquely named temporary database."""
    uri = os.getenv('TEST_MONGODB_URI', 'mongodb://127.0.0.1:27017')
    name = 'ridenow_integration_test_' + uuid.uuid4().hex
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


async def wait_for_state(http, path, headers, state, timeout):
    """Poll the public tracking API while the real simulation clock advances."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = await http.get(path, headers=headers)
        assert response.status_code == 200
        if response.json()['state'] == state:
            return response.json()
        await asyncio.sleep(1)
    pytest.fail(f'Tracking did not reach {state} within {timeout} seconds')


@pytest.mark.parametrize('vehicle', ['bike', 'parcel'])
async def test_completed_journey_crosses_identity_booking_tracking_history_and_feedback(client, vehicle):
    http, db = client
    login = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert login.status_code == 200
    headers = {'Authorization': 'Bearer ' + login.json()['token']}
    other = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert other.status_code == 200
    stranger = {'Authorization': 'Bearer ' + other.json()['token']}
    quote = await http.post('/api/v1/booking/quotes', headers=headers, json={'pickup': PICKUP, 'destination': DESTINATION})
    assert quote.status_code == 201
    body = {'quote_id': quote.json()['id'], 'vehicle': vehicle, 'payment': 'cash'}
    if vehicle == 'parcel':
        body['parcel'] = PARCEL
    assert (await http.post('/api/v1/booking/rides', headers=stranger, json=body)).status_code == 404
    booked = await http.post('/api/v1/booking/rides', headers=headers, json=body)
    assert booked.status_code == 201
    booking = booked.json()
    booking_id = booking['id']
    path = '/api/v1/tracking/' + booking_id
    receipt_path = '/api/v1/activity/history/' + booking_id
    assert (await http.get(receipt_path, headers=headers)).status_code == 404
    assert (await http.get(path, headers=stranger)).status_code == 404
    arrived = await wait_for_state(http, path, headers, 'arrived', 70)
    started = await http.post(path + '/pin', headers=headers, json={'pin': arrived['pin']})
    assert started.status_code == 200
    assert started.json()['state'] == ('collected' if vehicle == 'parcel' else 'in_trip')
    if vehicle == 'parcel':
        transit = await http.post(path + '/parcel/transit', headers=headers)
        assert transit.status_code == 200 and transit.json()['state'] == 'transit'
        completed = await http.post(path + '/parcel/deliver', headers=headers)
        assert completed.status_code == 200 and completed.json()['state'] == 'delivered'
    else:
        completed = await wait_for_state(http, path, headers, 'completed', 35)
        assert completed['booking']['status'] == 'completed'
    history = await http.get('/api/v1/activity/history', headers=headers)
    assert history.status_code == 200 and history.json()['total'] == 1
    assert history.json()['items'][0]['id'] == booking_id
    receipt = await http.get(receipt_path, headers=headers)
    assert receipt.status_code == 200
    assert receipt.json()['breakdown']['total'] == booking['vehicle']['fare']
    assert receipt.json()['quote_id'] == quote.json()['id']
    assert (await http.get(receipt_path, headers=stranger)).status_code == 404
    feedback = {'rating': 5, 'compliments': ['Polite driver'], 'tip_paise': 250}
    saved = await http.put(receipt_path + '/feedback', headers=headers, json=feedback)
    assert saved.status_code == 200 and saved.json() == feedback
    reread = await http.get(receipt_path, headers=headers)
    assert reread.status_code == 200 and reread.json()['feedback'] == feedback
    stored = await db.bookings.find_one({'_id': ObjectId(booking_id)})
    assert stored['status'] == 'completed' and stored['feedback'] == feedback
    assert stored['owner'] == ObjectId(login.json()['profile']['id'])
    assert stored['quote_id'] == ObjectId(quote.json()['id'])
    if vehicle == 'parcel':
        assert stored['parcel'] == PARCEL


@pytest.mark.parametrize('vehicle', ['bike', 'parcel'])
async def test_unfinished_and_cancelled_journeys_never_appear_in_history(client, vehicle):
    http, db = client
    login = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert login.status_code == 200
    headers = {'Authorization': 'Bearer ' + login.json()['token']}
    quote = await http.post('/api/v1/booking/quotes', headers=headers, json={'pickup': PICKUP, 'destination': DESTINATION})
    assert quote.status_code == 201
    body = {'quote_id': quote.json()['id'], 'vehicle': vehicle, 'payment': 'cash'}
    if vehicle == 'parcel':
        body['parcel'] = PARCEL
    booked = await http.post('/api/v1/booking/rides', headers=headers, json=body)
    assert booked.status_code == 201
    booking_id = booked.json()['id']
    path = '/api/v1/tracking/' + booking_id
    receipt = '/api/v1/activity/history/' + booking_id
    assert (await http.get(receipt, headers=headers)).status_code == 404
    assert (await http.put(receipt + '/feedback', headers=headers, json={'rating': 5})).status_code == 404
    assert (await http.post(path + '/parcel/deliver', headers=headers)).status_code == 409
    cancelled = await http.post(path + '/cancel', headers=headers, json={'confirmed': True})
    assert cancelled.status_code == 200 and cancelled.json()['state'] == 'cancelled'
    assert (await http.post(path + '/cancel', headers=headers, json={'confirmed': True})).status_code == 409
    history = await http.get('/api/v1/activity/history', headers=headers)
    assert history.status_code == 200 and history.json()['total'] == 0
    assert (await http.get(receipt, headers=headers)).status_code == 404
    stored = await db.bookings.find_one({'_id': ObjectId(booking_id)})
    assert stored['status'] == 'cancelled' and 'feedback' not in stored
    assert await db.bookings.count_documents({'quote_id': ObjectId(quote.json()['id'])}) == 1


async def test_saved_place_to_booking_and_reservation_edit_cancel(client):
    http, db = client
    login = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    other = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert login.status_code == 200 and other.status_code == 200
    owner_id = ObjectId(login.json()['profile']['id'])
    owner = {'Authorization': 'Bearer ' + login.json()['token']}
    stranger = {'Authorization': 'Bearer ' + other.json()['token']}
    saved = await http.put('/api/v1/locations/saved', headers=owner, json={**DESTINATION, 'label': 'Airport'})
    assert saved.status_code == 200
    place_id = saved.json()['id']
    own_places = await http.get('/api/v1/locations/saved', headers=owner)
    other_places = await http.get('/api/v1/locations/saved', headers=stranger)
    assert own_places.status_code == 200 and own_places.json()['items'][0]['id'] == place_id
    assert other_places.status_code == 200 and other_places.json()['total'] == 0
    assert (await http.delete('/api/v1/locations/saved/' + place_id, headers=stranger)).status_code == 404
    place = own_places.json()['items'][0]
    destination = {key: place[key] for key in ('name', 'lat', 'lng')}
    route = {'pickup': PICKUP, 'destination': destination}
    bad = await http.post('/api/v1/booking/quotes', headers=owner, json={'pickup': PICKUP, 'destination': PICKUP})
    assert bad.status_code == 422 and await db.quotes.count_documents({}) == 0
    quote = await http.post('/api/v1/booking/quotes', headers=owner, json=route)
    assert quote.status_code == 201 and quote.json()['destination'] == destination
    booking_data = {'quote_id': quote.json()['id'], 'vehicle': 'bike', 'payment': 'cash'}
    assert (await http.post('/api/v1/booking/rides', headers=stranger, json=booking_data)).status_code == 404
    booked = await http.post('/api/v1/booking/rides', headers=owner, json=booking_data)
    assert booked.status_code == 201 and booked.json()['destination'] == destination
    stored = await db.bookings.find_one({'_id': ObjectId(booked.json()['id'])})
    assert stored['owner'] == owner_id and stored['quote_id'] == ObjectId(quote.json()['id'])
    assert (await db.saved_locations.find_one({'_id': ObjectId(place_id)}))['owner'] == owner_id
    body = {**route, 'kind': 'reserve', 'scheduled_at': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(), 'vehicle': 'bike'}
    before_quotes = await db.quotes.count_documents({})
    created = await http.post('/api/v1/activity/schedules', headers=owner, json=body)
    assert created.status_code == 201 and created.json()['destination'] == destination
    sid = created.json()['id']
    path = '/api/v1/activity/schedules/' + sid
    assert (await http.put(path, headers=stranger, json=body)).status_code == 404
    edited = await http.put(path, headers=owner, json={**body, 'vehicle': 'auto'})
    assert edited.status_code == 200 and edited.json()['vehicle']['id'] == 'auto'
    listed = await http.get('/api/v1/activity/schedules', headers=owner)
    assert listed.status_code == 200 and listed.json()['items'][0]['id'] == sid
    assert (await http.post(path + '/cancel', headers=stranger)).status_code == 404
    cancelled = await http.post(path + '/cancel', headers=owner)
    assert cancelled.status_code == 200 and cancelled.json()['status'] == 'cancelled'
    before = await db.schedules.find_one({'_id': ObjectId(sid)})
    assert before['owner'] == owner_id and before['status'] == 'cancelled' and before['vehicle']['id'] == 'auto'
    assert (await http.put(path, headers=owner, json=body)).status_code == 409
    assert (await http.post(path + '/cancel', headers=owner)).status_code == 409
    assert await db.schedules.find_one({'_id': ObjectId(sid)}) == before
    assert await db.schedules.count_documents({}) == 1
    assert await db.quotes.count_documents({}) == before_quotes
    assert await db.bookings.count_documents({}) == 1
