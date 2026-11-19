"""Exercise location routes and ownership against a real isolated MongoDB."""
import os
import uuid

import httpx
import pytest
from pymongo import AsyncMongoClient

from app.main import Settings, create_app


@pytest.fixture
async def client():
    """Create and remove a uniquely named test database."""
    uri = os.getenv('TEST_MONGODB_URI', 'mongodb://127.0.0.1:27017')
    name = 'ridenow_test_' + uuid.uuid4().hex
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


async def test_search_is_bounded_literal_and_accurate(client):
    """Check catalogue paging, matching, coordinates and authentication."""
    http, _ = client
    assert (await http.get('/api/v1/locations/search')).status_code == 401
    entry = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert entry.status_code == 200
    token = entry.json()['token']
    headers = {'Authorization': 'Bearer ' + token}
    response = await http.get('/api/v1/locations/search', params={'limit': 50}, headers=headers)
    assert response.status_code == 200
    assert response.json()['total'] == 46
    assert {'name': 'Ramoji Film City, Hayathnagar', 'lat': 17.3123, 'lng': 78.6821} in response.json()['items']
    found = await http.get('/api/v1/locations/search', params={'q': 'rGiA'}, headers=headers)
    assert found.status_code == 200
    result = found.json()
    assert result['items'] == [{'name': 'Rajiv Gandhi International Airport (RGIA), Shamshabad', 'lat': 17.2403, 'lng': 78.4294}]
    literal = await http.get('/api/v1/locations/search', params={'q': '$ne'}, headers=headers)
    assert literal.status_code == 200 and literal.json()['total'] == 0
    assert (await http.get('/api/v1/locations/search', params={'limit': 51}, headers=headers)).status_code == 422
    assert (await http.get('/api/v1/locations/search', params={'offset': -1}, headers=headers)).status_code == 422
    page = await http.get('/api/v1/locations/search', params={'limit': 2, 'offset': 1}, headers=headers)
    assert page.status_code == 200 and len(page.json()['items']) == 2


async def test_saved_place_requires_finite_hyderabad_coordinates(client):
    """Reject non-finite coordinates and preserve existing saved places."""
    http, _ = client
    entry = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert entry.status_code == 200
    token = entry.json()['token']
    headers = {'Authorization': 'Bearer ' + token}
    response = await http.put('/api/v1/locations/saved', headers=headers, json={
        'label': 'Work', 'name': 'Cyber Towers', 'lat': 'NaN', 'lng': 78.3808,
    })
    assert response.status_code == 422
    listing = await http.get('/api/v1/locations/saved', headers=headers)
    assert listing.status_code == 200 and listing.json()['total'] == 0


async def test_saved_places_persist_are_owner_scoped_and_validate(client):
    """Verify upsert, persistence, isolation, deletion and invalid input."""
    http, db = client
    async def login():
        entry = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
        assert entry.status_code == 200
        token = entry.json()['token']
        return {'Authorization': 'Bearer ' + token}
    a, b = await login(), await login()
    payload = {'label': 'Home', 'name': 'Banjara Hills Road No. 12', 'lat': 17.4156, 'lng': 78.435}
    assert (await http.put('/api/v1/locations/saved', json=payload)).status_code == 401
    first = await http.put('/api/v1/locations/saved', headers=a, json=payload)
    assert first.status_code == 200
    place = first.json()
    assert await db.saved_locations.count_documents({}) == 1
    replaced = await http.put('/api/v1/locations/saved', headers=a, json={**payload, 'label': 'home', 'name': 'New home'})
    assert replaced.status_code == 200 and replaced.json()['id'] == place['id']
    own = await http.get('/api/v1/locations/saved', headers=a)
    other = await http.get('/api/v1/locations/saved', headers=b)
    assert own.status_code == 200 and own.json()['items'][0]['name'] == 'New home'
    assert other.status_code == 200 and other.json()['total'] == 0
    assert (await http.delete('/api/v1/locations/saved/' + place['id'], headers=b)).status_code == 404
    for invalid in ({**payload, 'lat': 19}, {**payload, 'lng': 0}, {**payload, 'name': ' '}, {**payload, 'label': {'$ne': ''}}, {**payload, 'owner': 'x'}):
        assert (await http.put('/api/v1/locations/saved', headers=a, json=invalid)).status_code == 422
    assert (await http.delete('/api/v1/locations/saved/not-an-id', headers=a)).status_code == 404
    assert (await http.delete('/api/v1/locations/saved/' + place['id'], headers=a)).status_code == 204
    listing = await http.get('/api/v1/locations/saved', headers=a)
    assert listing.status_code == 200 and listing.json()['total'] == 0


async def test_saved_index_pagination_and_invalid_inputs(client):
    http, db = client
    entry = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert entry.status_code == 200
    headers = {'Authorization': 'Bearer ' + entry.json()['token']}
    for endpoint in ('search', 'saved'):
        for params in ({'limit': 0}, {'limit': 51}, {'offset': -1}, {'offset': 10001}, {'limit': 'bad'}):
            assert (await http.get('/api/v1/locations/' + endpoint, headers=headers, params=params)).status_code == 422
    payload = {'label': 'Home', 'name': 'Cyber Towers', 'lat': 17.45, 'lng': 78.38}
    saved = await http.put('/api/v1/locations/saved', headers=headers, json=payload)
    assert saved.status_code == 200
    before = await db.saved_locations.find_one({})
    invalid = [{k: v for k, v in payload.items() if k != field} for field in payload]
    invalid += [{**payload, 'label': 'x' * 41}, {**payload, 'name': 'x' * 151},
                {**payload, 'name': {'$ne': ''}}, {**payload, 'label': ''},
                {**payload, 'lat': 17.199}, {**payload, 'lat': 17.551},
                {**payload, 'lng': 78.299}, {**payload, 'lng': 78.701}]
    for body in invalid:
        assert (await http.put('/api/v1/locations/saved', headers=headers, json=body)).status_code == 422
        assert await db.saved_locations.find_one({}) == before
    listing = await http.get('/api/v1/locations/saved', headers=headers)
    assert listing.status_code == 200 and listing.json()['items'] == [saved.json()]
    index = await db.saved_locations.index_information()
    assert any(info.get('unique') and info['key'] == [('owner', 1), ('label_key', 1)] for info in index.values())
    assert await db.saved_locations.count_documents({}) == 1


@pytest.mark.parametrize('field', ['name', 'label'])
@pytest.mark.parametrize('value', ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'A\nB', '\tA', 'A\x00B', 'A\x85B'])
async def test_saved_place_rejects_markup_and_controls_without_writing(client, field, value):
    http, db = client
    entry = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert entry.status_code == 200
    headers = {'Authorization': 'Bearer ' + entry.json()['token']}
    payload = {'label': 'Home', 'name': 'Cyber Towers', 'lat': 17.45, 'lng': 78.38}
    saved = await http.put('/api/v1/locations/saved', headers=headers, json=payload)
    assert saved.status_code == 200
    before = await db.saved_locations.find_one({})
    assert (await http.put('/api/v1/locations/saved', headers=headers, json={**payload, field: value})).status_code == 422
    listing = await http.get('/api/v1/locations/saved', headers=headers)
    assert listing.status_code == 200 and listing.json()['items'] == [saved.json()]
    assert await db.saved_locations.count_documents({}) == 1
    assert await db.saved_locations.find_one({}) == before


async def test_saved_place_accepts_boundaries_and_preserves_normal_names(client):
    http, db = client
    entry = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert entry.status_code == 200
    headers = {'Authorization': 'Bearer ' + entry.json()['token']}
    for payload in (
        {'label': "  D'Souza's Home  ", 'name': '  Café & Co., Road 1 / Hyderabad  ', 'lat': 17.20, 'lng': 78.30},
        {'label': 'x' * 40, 'name': 'y' * 150, 'lat': 17.55, 'lng': 78.70},
    ):
        saved = await http.put('/api/v1/locations/saved', headers=headers, json=payload)
        assert saved.status_code == 200
        assert {key: saved.json()[key] for key in payload} == payload
        assert await db.saved_locations.find_one({'name': payload['name']}) is not None
    listing = await http.get('/api/v1/locations/saved', headers=headers)
    assert listing.status_code == 200 and listing.json()['total'] == 2


async def test_legacy_saved_markup_remains_readable_but_cannot_be_written(client):
    http, db = client
    entry = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert entry.status_code == 200
    headers = {'Authorization': 'Bearer ' + entry.json()['token']}
    safe = {'label': 'Home', 'name': 'Cyber Towers', 'lat': 17.45, 'lng': 78.38}
    saved = await http.put('/api/v1/locations/saved', headers=headers, json=safe)
    assert saved.status_code == 200
    hostile = '<img src=x onerror=alert(1)>'
    await db.saved_locations.update_one({}, {'$set': {'name': hostile}})
    before = await db.saved_locations.find_one({})
    listing = await http.get('/api/v1/locations/saved', headers=headers)
    assert listing.status_code == 200 and listing.json()['items'][0]['name'] == hostile
    rejected = await http.put('/api/v1/locations/saved', headers=headers, json={**safe, 'name': hostile})
    assert rejected.status_code == 422
    assert await db.saved_locations.find_one({}) == before
