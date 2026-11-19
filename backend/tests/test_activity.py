"""Exercise activity APIs against a separate real MongoDB database."""
import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from bson import ObjectId
from pymongo import AsyncMongoClient

from app.main import Settings, create_app

PICKUP = {'name': 'Cyber Towers', 'lat': 17.4504, 'lng': 78.3808}
DESTINATION = {'name': 'RGIA', 'lat': 17.2403, 'lng': 78.4294}
BASE = '/api/v1/activity'


@pytest.fixture
async def client():
    """Use an isolated temporary Mongo database and the real app lifespan."""
    uri = os.getenv('TEST_MONGODB_URI', 'mongodb://127.0.0.1:27017')
    name = 'ridenow_activity_test_' + uuid.uuid4().hex
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
    """Create an independent rider session."""
    result = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert result.status_code == 200
    return {'Authorization': 'Bearer ' + result.json()['token']}


async def booking(http, headers):
    """Create a server-priced booking through the public API."""
    quote = await http.post('/api/v1/booking/quotes', headers=headers, json={'pickup': PICKUP, 'destination': DESTINATION})
    assert quote.status_code == 201
    result = await http.post('/api/v1/booking/rides', headers=headers, json={'quote_id': quote.json()['id'], 'vehicle': 'auto', 'payment': 'cash'})
    assert result.status_code == 201
    return result.json()


async def test_history_receipt_feedback_and_owner_isolation(client):
    """Only completed owned bookings appear; feedback and fare survive re-reads."""
    http, db = client
    a, b = await login(http), await login(http)
    ride = await booking(http, a)
    rid = ride['id']
    assert (await http.get(BASE + '/history', headers=a)).json()['total'] == 0
    assert (await http.get(BASE + '/history/' + rid, headers=a)).status_code == 404
    await db.bookings.update_one({'_id': ObjectId(rid)}, {'$set': {'status': 'completed'}})
    history = (await http.get(BASE + '/history', headers=a)).json()
    assert history['total'] == 1 and history['items'][0]['id'] == rid
    receipt = (await http.get(BASE + '/history/' + rid, headers=a)).json()
    assert receipt['breakdown']['total'] == ride['vehicle']['fare']
    assert receipt['breakdown']['base_and_distance'] == ride['vehicle']['base_fare']
    assert (await http.get(BASE + '/history/' + rid, headers=b)).status_code == 404
    data = {'rating': 5, 'compliments': ['Clean vehicle', 'Polite driver'], 'tip_paise': 2000}
    assert (await http.put(BASE + '/history/' + rid + '/feedback', headers=b, json=data)).status_code == 404
    assert (await http.put(BASE + '/history/' + rid + '/feedback', headers=a, json={**data, 'rating': 0})).status_code == 422
    assert (await http.put(BASE + '/history/' + rid + '/feedback', headers=a, json=data)).json() == data
    assert (await http.get(BASE + '/history/' + rid, headers=a)).json()['feedback'] == data
    assert (await http.get(BASE + '/history')).status_code == 401
    assert (await http.get(BASE + '/history/not-an-id', headers=a)).status_code == 404


async def test_wallet_atomic_increment_and_validation(client):
    """Concurrent additions accumulate in integer paise without crossing owners."""
    http, _ = client
    a, b = await login(http), await login(http)
    assert (await http.get(BASE + '/wallet', headers=a)).json()['balance_paise'] == 0
    results = await asyncio.gather(*[http.post(BASE + '/wallet/funds', headers=a, json={'amount_paise': 125}) for _ in range(12)])
    assert all(r.status_code == 200 for r in results)
    assert (await http.get(BASE + '/wallet', headers=a)).json()['balance_paise'] == 1500
    assert (await http.get(BASE + '/wallet', headers=b)).json()['balance_paise'] == 0
    for value in (0, -1, 1.5, '100'):
        assert (await http.post(BASE + '/wallet/funds', headers=a, json={'amount_paise': value})).status_code == 422
    assert (await http.post(BASE + '/wallet/funds', json={'amount_paise': 1})).status_code == 401


async def test_reservations_validate_edit_cancel_and_isolation(client):
    """Reservations have future dates and cannot be modified across owners or after cancellation."""
    http, db = client
    a, b = await login(http), await login(http)
    future = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    body = {'kind': 'hourly', 'pickup': PICKUP, 'destination': DESTINATION, 'scheduled_at': future, 'vehicle': 'bike'}
    assert (await http.post(BASE + '/schedules', headers=a, json={**body, 'scheduled_at': '2000-01-01T00:00:00Z'})).status_code == 422
    assert (await http.post(BASE + '/schedules', headers=a, json={**body, 'scheduled_at': '2099-01-01T00:00:00'})).status_code == 422
    assert (await http.post(BASE + '/schedules', headers=a, json={**body, 'destination': PICKUP})).status_code == 422
    response = await http.post(BASE + '/schedules', headers=a, json=body)
    assert response.status_code == 201
    s = response.json(); sid = s['id']
    assert s['kind'] == 'hourly' and s['vehicle']['fare'] >= 30
    assert (await http.get(BASE + '/schedules', headers=b)).json()['total'] == 0
    assert (await http.put(BASE + '/schedules/' + sid, headers=b, json=body)).status_code == 404
    assert (await http.post(BASE + '/schedules/' + sid + '/cancel', headers=b)).status_code == 404
    changed = await http.put(BASE + '/schedules/' + sid, headers=a, json={**body, 'vehicle': 'auto', 'kind': 'reserve'})
    assert changed.status_code == 200 and changed.json()['vehicle']['id'] == 'auto'
    assert (await db.schedules.find_one({'_id': ObjectId(sid)}))['kind'] == 'reserve'
    assert (await http.post(BASE + '/schedules/' + sid + '/cancel', headers=a)).json()['status'] == 'cancelled'
    assert (await http.post(BASE + '/schedules/' + sid + '/cancel', headers=a)).status_code == 409
    assert (await http.put(BASE + '/schedules/' + sid, headers=a, json=body)).status_code == 409
    assert (await http.get(BASE + '/schedules', headers=a)).json()['total'] == 0


async def test_expired_reservations_are_not_upcoming_or_editable(client):
    """Past reservations are excluded from pages and cannot be changed."""
    http, db = client
    headers = await login(http)
    body = {'kind': 'reserve', 'pickup': PICKUP, 'destination': DESTINATION,
            'scheduled_at': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(), 'vehicle': 'bike'}
    expired = (await http.post(BASE + '/schedules', headers=headers, json=body)).json()
    future = (await http.post(BASE + '/schedules', headers=headers, json=body)).json()
    await db.schedules.update_one({'_id': ObjectId(expired['id'])}, {'$set': {'scheduled_at': datetime.now(timezone.utc) - timedelta(seconds=1)}})
    page = (await http.get(BASE + '/schedules?limit=1', headers=headers)).json()
    assert page['total'] == 1 and [s['id'] for s in page['items']] == [future['id']]
    assert (await http.post(BASE + '/schedules/' + expired['id'] + '/cancel', headers=headers)).status_code == 409
    assert (await http.put(BASE + '/schedules/' + expired['id'], headers=headers, json=body)).status_code == 409
