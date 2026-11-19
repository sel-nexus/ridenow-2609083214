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
    token = (await http.post('/api/v1/identity/enter', json={'method': 'guest'})).json()['token']
    headers = {'Authorization': 'Bearer ' + token}
    response = await http.get('/api/v1/locations/search', params={'limit': 50}, headers=headers)
    assert response.status_code == 200
    assert response.json()['total'] == 46
    assert {'name': 'Ramoji Film City, Hayathnagar', 'lat': 17.3123, 'lng': 78.6821} in response.json()['items']
    result = (await http.get('/api/v1/locations/search', params={'q': 'rGiA'}, headers=headers)).json()
    assert result['items'] == [{'name': 'Rajiv Gandhi International Airport (RGIA), Shamshabad', 'lat': 17.2403, 'lng': 78.4294}]
    assert (await http.get('/api/v1/locations/search', params={'q': '$ne'}, headers=headers)).json()['total'] == 0
    assert (await http.get('/api/v1/locations/search', params={'limit': 51}, headers=headers)).status_code == 422
    assert (await http.get('/api/v1/locations/search', params={'offset': -1}, headers=headers)).status_code == 422
    assert len((await http.get('/api/v1/locations/search', params={'limit': 2, 'offset': 1}, headers=headers)).json()['items']) == 2


async def test_saved_place_requires_finite_hyderabad_coordinates(client):
    """Reject non-finite coordinates and preserve existing saved places."""
    http, _ = client
    token = (await http.post('/api/v1/identity/enter', json={'method': 'guest'})).json()['token']
    headers = {'Authorization': 'Bearer ' + token}
    response = await http.put('/api/v1/locations/saved', headers=headers, json={
        'label': 'Work', 'name': 'Cyber Towers', 'lat': 'NaN', 'lng': 78.3808,
    })
    assert response.status_code == 422
    assert (await http.get('/api/v1/locations/saved', headers=headers)).json()['total'] == 0


async def test_saved_places_persist_are_owner_scoped_and_validate(client):
    """Verify upsert, persistence, isolation, deletion and invalid input."""
    http, db = client
    async def login():
        token = (await http.post('/api/v1/identity/enter', json={'method': 'guest'})).json()['token']
        return {'Authorization': 'Bearer ' + token}
    a, b = await login(), await login()
    payload = {'label': 'Home', 'name': 'Banjara Hills Road No. 12', 'lat': 17.4156, 'lng': 78.435}
    assert (await http.put('/api/v1/locations/saved', json=payload)).status_code == 401
    first = await http.put('/api/v1/locations/saved', headers=a, json=payload)
    assert first.status_code == 200
    place = first.json()
    assert await db.saved_locations.count_documents({}) == 1
    replaced = await http.put('/api/v1/locations/saved', headers=a, json={**payload, 'label': 'home', 'name': 'New home'})
    assert replaced.json()['id'] == place['id']
    assert (await http.get('/api/v1/locations/saved', headers=a)).json()['items'][0]['name'] == 'New home'
    assert (await http.get('/api/v1/locations/saved', headers=b)).json()['total'] == 0
    assert (await http.delete('/api/v1/locations/saved/' + place['id'], headers=b)).status_code == 404
    for invalid in ({**payload, 'lat': 19}, {**payload, 'lng': 0}, {**payload, 'name': ' '}, {**payload, 'label': {'$ne': ''}}, {**payload, 'owner': 'x'}):
        assert (await http.put('/api/v1/locations/saved', headers=a, json=invalid)).status_code == 422
    assert (await http.delete('/api/v1/locations/saved/not-an-id', headers=a)).status_code == 404
    assert (await http.delete('/api/v1/locations/saved/' + place['id'], headers=a)).status_code == 204
    assert (await http.get('/api/v1/locations/saved', headers=a)).json()['total'] == 0
