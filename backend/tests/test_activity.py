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
    empty_history = await http.get(BASE + '/history', headers=a)
    assert empty_history.status_code == 200 and empty_history.json()['total'] == 0
    assert (await http.get(BASE + '/history/' + rid, headers=a)).status_code == 404
    await db.bookings.update_one({'_id': ObjectId(rid)}, {'$set': {'status': 'completed'}})
    history_response = await http.get(BASE + '/history', headers=a)
    assert history_response.status_code == 200
    history = history_response.json()
    assert history['total'] == 1 and history['items'][0]['id'] == rid
    receipt_response = await http.get(BASE + '/history/' + rid, headers=a)
    assert receipt_response.status_code == 200
    receipt = receipt_response.json()
    assert receipt['breakdown']['total'] == ride['vehicle']['fare']
    assert receipt['breakdown']['base_and_distance'] == ride['vehicle']['base_fare']
    assert (await http.get(BASE + '/history/' + rid, headers=b)).status_code == 404
    data = {'rating': 5, 'compliments': ['Clean vehicle', 'Polite driver'], 'tip_paise': 2000}
    assert (await http.put(BASE + '/history/' + rid + '/feedback', headers=b, json=data)).status_code == 404
    assert (await http.put(BASE + '/history/' + rid + '/feedback', headers=a, json={**data, 'rating': 0})).status_code == 422
    feedback_response = await http.put(BASE + '/history/' + rid + '/feedback', headers=a, json=data)
    assert feedback_response.status_code == 200 and feedback_response.json() == data
    reread = await http.get(BASE + '/history/' + rid, headers=a)
    assert reread.status_code == 200 and reread.json()['feedback'] == data
    assert (await http.get(BASE + '/history')).status_code == 401
    assert (await http.get(BASE + '/history/not-an-id', headers=a)).status_code == 404


async def test_wallet_atomic_increment_and_validation(client):
    """Concurrent additions accumulate in integer paise without crossing owners."""
    http, _ = client
    a, b = await login(http), await login(http)
    initial = await http.get(BASE + '/wallet', headers=a)
    assert initial.status_code == 200 and initial.json()['balance_paise'] == 0
    assert (await http.get(BASE + '/wallet')).status_code == 401
    assert (await http.get(BASE + '/wallet', headers={'Authorization': 'Bearer invalid'})).status_code == 401
    results = await asyncio.gather(*[http.post(BASE + '/wallet/funds', headers=a, json={'amount_paise': 125}) for _ in range(12)])
    assert all(r.status_code == 200 for r in results)
    balance = await http.get(BASE + '/wallet', headers=a)
    other_balance = await http.get(BASE + '/wallet', headers=b)
    assert balance.status_code == 200 and balance.json()['balance_paise'] == 1500
    assert other_balance.status_code == 200 and other_balance.json()['balance_paise'] == 0
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
    other_schedules = await http.get(BASE + '/schedules', headers=b)
    assert other_schedules.status_code == 200 and other_schedules.json()['total'] == 0
    assert (await http.put(BASE + '/schedules/' + sid, headers=b, json=body)).status_code == 404
    assert (await http.post(BASE + '/schedules/' + sid + '/cancel', headers=b)).status_code == 404
    changed = await http.put(BASE + '/schedules/' + sid, headers=a, json={**body, 'vehicle': 'auto', 'kind': 'reserve'})
    assert changed.status_code == 200 and changed.json()['vehicle']['id'] == 'auto'
    assert (await db.schedules.find_one({'_id': ObjectId(sid)}))['kind'] == 'reserve'
    cancelled = await http.post(BASE + '/schedules/' + sid + '/cancel', headers=a)
    assert cancelled.status_code == 200 and cancelled.json()['status'] == 'cancelled'
    before = await db.schedules.find_one({'_id': ObjectId(sid)})
    count = await db.quotes.count_documents({})
    assert (await http.post(BASE + '/schedules/' + sid + '/cancel', headers=a)).status_code == 409
    assert (await http.put(BASE + '/schedules/' + sid, headers=a, json=body)).status_code == 409
    assert await db.quotes.count_documents({}) == count
    after = await db.schedules.find_one({'_id': ObjectId(sid)})
    assert after == before and after['status'] == 'cancelled'
    profile = await http.get('/api/v1/identity/profile', headers=a)
    assert profile.status_code == 200 and after['owner'] == ObjectId(profile.json()['id'])
    upcoming = await http.get(BASE + '/schedules', headers=a)
    assert upcoming.status_code == 200 and upcoming.json()['total'] == 0


async def test_expired_reservations_are_not_upcoming_or_editable(client):
    """Past reservations are excluded from pages and cannot be changed."""
    http, db = client
    headers = await login(http)
    body = {'kind': 'reserve', 'pickup': PICKUP, 'destination': DESTINATION,
            'scheduled_at': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(), 'vehicle': 'bike'}
    expired_response = await http.post(BASE + '/schedules', headers=headers, json=body)
    assert expired_response.status_code == 201
    expired = expired_response.json()
    future_response = await http.post(BASE + '/schedules', headers=headers, json=body)
    assert future_response.status_code == 201
    future = future_response.json()
    await db.schedules.update_one({'_id': ObjectId(expired['id'])}, {'$set': {'scheduled_at': datetime.now(timezone.utc) - timedelta(seconds=1)}})
    page_response = await http.get(BASE + '/schedules?limit=1', headers=headers)
    assert page_response.status_code == 200
    page = page_response.json()
    assert page['total'] == 1 and [s['id'] for s in page['items']] == [future['id']]
    assert (await http.post(BASE + '/schedules/' + expired['id'] + '/cancel', headers=headers)).status_code == 409
    before = await db.schedules.find_one({'_id': ObjectId(expired['id'])})
    count = await db.quotes.count_documents({})
    assert (await http.put(BASE + '/schedules/' + expired['id'], headers=headers, json=body)).status_code == 409
    assert await db.quotes.count_documents({}) == count
    assert await db.schedules.find_one({'_id': ObjectId(expired['id'])}) == before


async def test_activity_validation_pagination_and_state_rereads(client):
    http, db = client
    owner, stranger = await login(http), await login(http)
    ride = await booking(http, owner)
    path = BASE + '/history/' + ride['id']
    feedback = {'rating': 5, 'compliments': ['Clean vehicle'], 'tip_paise': 100}
    assert (await http.put(path + '/feedback', headers=owner, json=feedback)).status_code == 404
    await db.bookings.update_one({'_id': ObjectId(ride['id'])}, {'$set': {'status': 'completed'}})
    for body in ({}, {'rating': 6}, {'rating': {'$gt': 0}}, {'rating': 5, 'tip_paise': -1},
                 {'rating': 5, 'tip_paise': 1000001}, {'rating': 5, 'compliments': ['x' * 1000]}):
        assert (await http.put(path + '/feedback', headers=owner, json=body)).status_code == 422
    assert (await http.put(path + '/feedback', headers=stranger, json=feedback)).status_code == 404
    saved = await http.put(path + '/feedback', headers=owner, json=feedback)
    assert saved.status_code == 200 and saved.json() == feedback
    receipt = await http.get(path, headers=owner)
    assert receipt.status_code == 200 and receipt.json()['feedback'] == feedback
    assert (await db.bookings.find_one({'_id': ObjectId(ride['id'])}))['feedback'] == feedback
    for endpoint in ('history', 'schedules'):
        for params in ({'limit': 0}, {'limit': 101}, {'offset': -1}, {'limit': 'bad'}):
            assert (await http.get(BASE + '/' + endpoint, headers=owner, params=params)).status_code == 422
    for body in ({}, {'amount_paise': {'$inc': 1}}, {'amount_paise': 10000001}):
        assert (await http.post(BASE + '/wallet/funds', headers=owner, json=body)).status_code == 422
    wallet = await http.get(BASE + '/wallet', headers=owner)
    assert wallet.status_code == 200 and wallet.json()['balance_paise'] == 0
    assert (await http.post(BASE + '/schedules', headers=owner, json={})).status_code == 422
    assert (await http.post(BASE + '/schedules/not-an-id/cancel', headers=owner)).status_code == 404
    assert (await http.post(BASE + '/schedules/' + str(ObjectId()) + '/cancel', headers=owner)).status_code == 404


async def test_schedule_missing_and_invalid_fields_do_not_write(client):
    http, db = client
    owner = await login(http)
    body = {'kind': 'reserve', 'pickup': PICKUP, 'destination': DESTINATION,
            'scheduled_at': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(), 'vehicle': 'bike'}
    invalid = [{k: v for k, v in body.items() if k != key} for key in body]
    invalid += [{**body, 'kind': 'other'}, {**body, 'vehicle': 'other'},
                {**body, 'scheduled_at': 'not-a-date'}, {**body, 'scheduled_at': None}]
    for location in ('pickup', 'destination'):
        for field in ('name', 'lat', 'lng'):
            invalid.append({**body, location: {k: v for k, v in body[location].items() if k != field}})
        invalid.extend([{**body, location: {**body[location], 'name': ''}},
                        {**body, location: {**body[location], 'name': 'x' * 151}},
                        {**body, location: {**body[location], 'name': '<script>alert(1)</script>'}},
                        {**body, location: {**body[location], 'name': 'Place\nName'}},
                        {**body, location: {**body[location], 'lat': 17.199}},
                        {**body, location: {**body[location], 'lat': 17.551}},
                        {**body, location: {**body[location], 'lng': 78.299}},
                        {**body, location: {**body[location], 'lng': 78.701}},
                        {**body, location: {'$ne': None}}])
    for payload in invalid:
        assert (await http.post(BASE + '/schedules', headers=owner, json=payload)).status_code == 422
    assert await db.schedules.count_documents({}) == 0
    assert await db.quotes.count_documents({}) == 0
    created = await http.post(BASE + '/schedules', headers=owner, json=body)
    assert created.status_code == 201
    sid = created.json()['id']
    before = await db.schedules.find_one({'_id': ObjectId(sid)})
    for payload in invalid:
        assert (await http.put(BASE + '/schedules/' + sid, headers=owner, json=payload)).status_code == 422
    assert await db.schedules.find_one({'_id': ObjectId(sid)}) == before
    assert await db.quotes.count_documents({}) == 0
    reread = await http.get(BASE + '/schedules', headers=owner)
    assert reread.status_code == 200 and reread.json()['total'] == 1
    assert reread.json()['items'][0]['id'] == sid


async def test_concurrent_cancellation_during_edit_leaves_no_quote(client, monkeypatch):
    from app.activity import ActivityRepository

    http, db = client
    owner = await login(http)
    body = {'kind': 'reserve', 'pickup': PICKUP, 'destination': DESTINATION,
            'scheduled_at': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(), 'vehicle': 'bike'}
    created = await http.post(BASE + '/schedules', headers=owner, json=body)
    assert created.status_code == 201
    sid = created.json()['id']
    count = await db.quotes.count_documents({})
    original = ActivityRepository.schedule

    async def cancel_before_update(repo, schedule_id, fields):
        await db.schedules.update_one({'_id': ObjectId(schedule_id)}, {'$set': {'status': 'cancelled'}})
        return await original(repo, schedule_id, fields)

    monkeypatch.setattr(ActivityRepository, 'schedule', cancel_before_update)
    assert (await http.put(BASE + '/schedules/' + sid, headers=owner, json=body)).status_code == 409
    assert await db.quotes.count_documents({}) == count
    stored = await db.schedules.find_one({'_id': ObjectId(sid)})
    assert stored['status'] == 'cancelled' and stored['vehicle']['id'] == 'bike'
