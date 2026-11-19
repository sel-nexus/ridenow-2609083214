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
    health = await http.get('/api/health')
    assert health.status_code == 200 and health.json() == {'status': 'ok'}
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
    reread = await http.get('/api/v1/identity/profile', headers=headers)
    assert reread.status_code == 200 and reread.json()['first_name'] == 'Asha'
    assert (await db.profiles.find_one({'first_name': 'Asha'}))['email'] == 'asha@example.com'
    assert (await http.post('/api/v1/identity/logout', headers=headers)).status_code == 204
    assert (await http.get('/api/v1/identity/profile', headers=headers)).status_code == 401


@pytest.mark.parametrize('method', ['google', 'apple', 'guest'])
async def test_fast_entries_are_distinct_and_owner_scoped(client, method):
    http, _ = client
    one_response = await http.post('/api/v1/identity/enter', json={'method': method})
    assert one_response.status_code == 200
    one = one_response.json()
    two_response = await http.post('/api/v1/identity/enter', json={'method': method})
    assert two_response.status_code == 200
    two = two_response.json()
    assert one['profile']['id'] != two['profile']['id']
    assert one['profile']['method'] == method
    a = {'Authorization': 'Bearer ' + one['token']}
    b = {'Authorization': 'Bearer ' + two['token']}
    assert (await http.put('/api/v1/identity/profile', headers=a, json={'first_name': 'First'})).status_code == 200
    other = await http.get('/api/v1/identity/profile', headers=b)
    assert other.status_code == 200 and other.json()['first_name'] != 'First'
    assert (await http.put('/api/v1/identity/profile', headers=b, json={'first_name': 'Second', 'id': one['profile']['id']})).status_code == 422


async def test_validation_expiry_and_unauthorized(client):
    http, db = client
    assert (await http.post('/api/v1/identity/enter', json={'method': 'facebook'})).status_code == 422
    assert (await http.post('/api/v1/identity/phone/start', json={'phone': {'$ne': ''}})).status_code == 422
    assert (await http.get('/api/v1/identity/profile')).status_code == 401
    assert (await http.get('/api/v1/identity/profile', headers={'Authorization': 'Bearer invalid'})).status_code == 401
    entry = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert entry.status_code == 200
    token = entry.json()['token']
    headers = {'Authorization': 'Bearer ' + token}
    for fields in ({'first_name': ' '}, {'first_name': 'X', 'email': 'bad'}, {'first_name': 'X', 'phone': '123'}, {'first_name': 'X', 'photo': 'https://example.com/a.png'}):
        assert (await http.put('/api/v1/identity/profile', headers=headers, json=fields)).status_code == 422
    await db.sessions.update_one({'_id': digest(token)}, {'$set': {'expires_at': datetime.now(timezone.utc) - timedelta(seconds=1)}})
    assert (await http.get('/api/v1/identity/profile', headers=headers)).status_code == 401
    started = await http.post('/api/v1/identity/phone/start', json={'phone': '+919876543210'})
    assert started.status_code == 200
    challenge = started.json()['challenge']
    await db.challenges.update_one({'_id': digest(challenge)}, {'$set': {'expires_at': datetime.now(timezone.utc) - timedelta(seconds=1)}})
    assert (await http.post('/api/v1/identity/phone/verify', json={'challenge': challenge, 'otp': '123456'})).status_code == 401


async def test_identity_missing_oversize_and_operator_inputs_leave_state_unchanged(client):
    http, db = client
    for path, body in [('/phone/start', {}), ('/phone/start', {'phone': '1' * 1000}),
                       ('/phone/verify', {'otp': '1234'}),
                       ('/phone/verify', {'challenge': {'$ne': ''}, 'otp': '1234'}),
                       ('/enter', {'method': {'$in': ['guest']}}), ('/enter', {})]:
        assert (await http.post('/api/v1/identity' + path, json=body)).status_code == 422
    entry = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert entry.status_code == 200
    headers = {'Authorization': 'Bearer ' + entry.json()['token']}
    for body in ({}, {'first_name': 'x' * 61}, {'first_name': {'$ne': ''}},
                 {'first_name': 'Valid', 'photo': 'x' * 200001}):
        assert (await http.put('/api/v1/identity/profile', headers=headers, json=body)).status_code == 422
    reread = await http.get('/api/v1/identity/profile', headers=headers)
    assert reread.status_code == 200 and reread.json()['first_name'] == 'Guest'
    assert await db.profiles.count_documents({}) == 1


@pytest.mark.parametrize('field', ['first_name', 'last_name'])
@pytest.mark.parametrize('value', ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'A\nB', '\tA', 'A\x00B', 'A\x85B'])
async def test_profile_rejects_markup_and_controls_without_writing(client, field, value):
    http, db = client
    entry = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert entry.status_code == 200
    headers = {'Authorization': 'Bearer ' + entry.json()['token']}
    before = await db.profiles.find_one({})
    updated = await http.put('/api/v1/identity/profile', headers=headers, json={'first_name': 'Asha', field: value})
    assert updated.status_code == 422
    reread = await http.get('/api/v1/identity/profile', headers=headers)
    assert reread.status_code == 200 and reread.json() == entry.json()['profile']
    assert await db.profiles.find_one({}) == before


async def test_profile_names_allow_unicode_punctuation_and_preserve_input(client):
    http, db = client
    entry = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert entry.status_code == 200
    headers = {'Authorization': 'Bearer ' + entry.json()['token']}
    names = {'first_name': '  Asha-Marie  ', 'last_name': "D'Souza 李"}
    updated = await http.put('/api/v1/identity/profile', headers=headers, json=names)
    assert updated.status_code == 200
    reread = await http.get('/api/v1/identity/profile', headers=headers)
    assert reread.status_code == 200
    assert {key: reread.json()[key] for key in names} == names
    assert {key: (await db.profiles.find_one({}))[key] for key in names} == names


async def test_verify_required_fields_and_invalid_otp_preserve_challenge(client):
    http, db = client
    started = await http.post('/api/v1/identity/phone/start', json={'phone': '+919876543210'})
    assert started.status_code == 200
    challenge = started.json()['challenge']
    before = await db.challenges.find_one({'_id': digest(challenge)})
    for payload in ({'challenge': challenge}, {'otp': '1234'},
                    {'challenge': challenge, 'otp': ''}, {'challenge': challenge, 'otp': '1' * 7},
                    {'challenge': challenge, 'otp': {'$ne': ''}},
                    {'challenge': '', 'otp': '1234'}, {'challenge': 'x' * 129, 'otp': '1234'}):
        assert (await http.post('/api/v1/identity/phone/verify', json=payload)).status_code == 422
    assert await db.challenges.find_one({'_id': digest(challenge)}) == before
    assert await db.sessions.count_documents({}) == 0
    assert await db.profiles.count_documents({}) == 0
    verified = await http.post('/api/v1/identity/phone/verify', json={'challenge': challenge, 'otp': '1234'})
    assert verified.status_code == 200


async def test_unauthorized_logout_does_not_revoke_another_session(client):
    http, db = client
    entry = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert entry.status_code == 200
    token = entry.json()['token']
    assert (await http.post('/api/v1/identity/logout')).status_code == 401
    assert (await http.post('/api/v1/identity/logout', headers={'Authorization': 'Bearer invalid'})).status_code == 401
    assert await db.sessions.find_one({'_id': digest(token)}) is not None
    assert (await http.get('/api/v1/identity/profile', headers={'Authorization': 'Bearer ' + token})).status_code == 200
