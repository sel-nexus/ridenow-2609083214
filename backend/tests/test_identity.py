"""Exercise identity HTTP routes against an isolated real Mongo database."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from pymongo import AsyncMongoClient

from app.core import digest
from app.main import Settings, create_app


@pytest.fixture
async def client():
    """Use a unique database and remove only that test database afterward."""
    uri = os.getenv("TEST_MONGODB_URI", "mongodb://127.0.0.1:27017")
    name = "ridenow_test_" + uuid.uuid4().hex
    app = create_app(Settings(mongodb_uri=uri, mongodb_db=name))
    try:
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
                yield http, app.state.db
    finally:
        cleanup = AsyncMongoClient(uri, serverSelectionTimeoutMS=3000)
        try:
            await cleanup.drop_database(name)
        finally:
            await cleanup.close()


async def test_phone_challenge_and_session_persist(client):
    http, db = client
    assert (await http.get('/api/health')).json() == {'status': 'ok'}
    started = await http.post('/api/v1/identity/phone/start', json={'phone': '+919876543210'})
    assert started.status_code == 200 and 'no SMS' in started.json()['message']
    challenge = started.json()['challenge']
    assert (await http.post('/api/v1/identity/phone/verify', json={'challenge': challenge, 'otp': 'abc4'})).status_code == 422
    login = await http.post('/api/v1/identity/phone/verify', json={'challenge': challenge, 'otp': '1234'})
    assert login.status_code == 200
    token = login.json()['token']
    assert login.json()['profile']['phone'] == '+919876543210'
    assert await db.sessions.find_one({'_id': digest(token)})
    assert await db.sessions.find_one({'_id': token}) is None
    assert (await http.post('/api/v1/identity/phone/verify', json={'challenge': challenge, 'otp': '123456'})).status_code == 401
    headers = {'Authorization': f'Bearer {token}'}
    updated = await http.put('/api/v1/identity/profile', headers=headers, json={'first_name': 'Asha', 'last_name': 'Rao', 'phone': '+919876543210', 'email': 'asha@example.com', 'photo': ''})
    assert updated.status_code == 200
    assert (await http.get('/api/v1/identity/profile', headers=headers)).json()['first_name'] == 'Asha'
    assert (await db.profiles.find_one({'first_name': 'Asha'}))['email'] == 'asha@example.com'
    assert (await http.post('/api/v1/identity/logout', headers=headers)).status_code == 204
    assert (await http.get('/api/v1/identity/profile', headers=headers)).status_code == 401


@pytest.mark.parametrize('method', ['google', 'apple', 'guest'])
async def test_fast_entries_are_distinct_and_owner_scoped(client, method):
    http, _ = client
    one = (await http.post('/api/v1/identity/enter', json={'method': method})).json()
    two = (await http.post('/api/v1/identity/enter', json={'method': method})).json()
    assert one['profile']['id'] != two['profile']['id']
    assert one['profile']['method'] == method
    a = {'Authorization': 'Bearer ' + one['token']}
    b = {'Authorization': 'Bearer ' + two['token']}
    assert (await http.put('/api/v1/identity/profile', headers=a, json={'first_name': 'First'})).status_code == 200
    assert (await http.get('/api/v1/identity/profile', headers=b)).json()['first_name'] != 'First'
    assert (await http.put('/api/v1/identity/profile', headers=b, json={'first_name': 'Second', 'id': one['profile']['id']})).status_code == 422


async def test_validation_expiry_and_unauthorized(client):
    http, db = client
    assert (await http.post('/api/v1/identity/enter', json={'method': 'facebook'})).status_code == 422
    assert (await http.post('/api/v1/identity/phone/start', json={'phone': {'$ne': ''}})).status_code == 422
    assert (await http.get('/api/v1/identity/profile')).status_code == 401
    assert (await http.get('/api/v1/identity/profile', headers={'Authorization': 'Bearer invalid'})).status_code == 401
    token = (await http.post('/api/v1/identity/enter', json={'method': 'guest'})).json()['token']
    headers = {'Authorization': 'Bearer ' + token}
    for fields in ({'first_name': ' '}, {'first_name': 'X', 'email': 'bad'}, {'first_name': 'X', 'phone': '123'}, {'first_name': 'X', 'photo': 'https://example.com/a.png'}):
        assert (await http.put('/api/v1/identity/profile', headers=headers, json=fields)).status_code == 422
    await db.sessions.update_one({'_id': digest(token)}, {'$set': {'expires_at': datetime.now(timezone.utc) - timedelta(seconds=1)}})
    assert (await http.get('/api/v1/identity/profile', headers=headers)).status_code == 401
    challenge = (await http.post('/api/v1/identity/phone/start', json={'phone': '+919876543210'})).json()['challenge']
    await db.challenges.update_one({'_id': digest(challenge)}, {'$set': {'expires_at': datetime.now(timezone.utc) - timedelta(seconds=1)}})
    assert (await http.post('/api/v1/identity/phone/verify', json={'challenge': challenge, 'otp': '123456'})).status_code == 401
