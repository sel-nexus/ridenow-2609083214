"""Test booking APIs against an isolated real MongoDB database."""
import os
import uuid

import httpx
import pytest
from bson import ObjectId
from pymongo import AsyncMongoClient
from pymongo.errors import DuplicateKeyError

from app.booking import prices, road_distance
from app.locations import Location
from app.main import Settings, create_app

PICKUP = {'name': 'Cyber Towers', 'lat': 17.4504, 'lng': 78.3808}
AIRPORT = {'name': 'RGIA', 'lat': 17.2403, 'lng': 78.4294}
BASE = '/api/v1/booking'


@pytest.fixture
async def client():
    """Create a temporary database using the real MongoDB server."""
    uri = os.getenv('TEST_MONGODB_URI', 'mongodb://127.0.0.1:27017')
    name = 'ridenow_booking_test_' + uuid.uuid4().hex
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
    """Create an independent session through the identity API."""
    response = await http.post('/api/v1/identity/enter', json={'method': 'guest'})
    assert response.status_code == 200
    return {'Authorization': 'Bearer ' + response.json()['token']}


def test_fare_formula_tiers_surge_and_road_estimate():
    """Verify distance base, tier supplements and 10 percent demand adjustment."""
    assert prices(0, False)[0]['fare'] == 30
    assert prices(3, False)[0]['fare'] == 30
    assert prices(5.25, False)[0]['fare'] == 41.25
    fares = prices(5.25, True)
    assert fares[0]['fare'] == 45.38
    assert fares[1]['original_fare'] == 51.25
    assert fares[1]['fare'] == 56.38
    assert len(fares) == 7 and fares[5]['fare'] > fares[3]['fare'] > fares[2]['fare'] > fares[1]['fare'] > fares[0]['fare']
    assert 32 < road_distance(Location(**PICKUP), Location(**AIRPORT)) < 35


async def test_booking_persists_server_calculated_fare_and_is_owner_scoped(client):
    """Book an owned quote and re-read its persisted snapshot."""
    http, db = client
    a, b = await login(http), await login(http)
    response = await http.post(BASE + '/quotes', headers=a, json={'pickup': PICKUP, 'destination': AIRPORT})
    assert response.status_code == 201
    quote = response.json()
    assert len(quote['vehicles']) == 7
    assert quote['surge_multiplier'] in (1.0, 1.1)
    assert (await http.post(BASE + '/rides', headers=b, json={'quote_id': quote['id'], 'vehicle': 'uberxl', 'payment': 'cash'})).status_code == 404
    created = await http.post(BASE + '/rides', headers=a, json={'quote_id': quote['id'], 'vehicle': 'uberxl', 'payment': 'cash'})
    assert created.status_code == 201
    ride = created.json()
    assert ride['vehicle'] == next(item for item in quote['vehicles'] if item['id'] == 'uberxl')
    assert ride['payment'] == 'cash' and ride['status'] == 'confirmed'
    stored = await db.bookings.find_one({'_id': ObjectId(ride['id'])})
    assert stored['vehicle']['fare'] == ride['vehicle']['fare'] and stored['destination'] == AIRPORT
    reread = await http.get(BASE + '/rides/' + ride['id'], headers=a)
    assert reread.status_code == 200 and reread.json() == ride
    assert (await http.get(BASE + '/rides/' + ride['id'], headers=b)).status_code == 404
    assert (await http.post(BASE + '/rides', headers=a, json={'quote_id': quote['id'], 'vehicle': 'bike', 'payment': 'cash'})).status_code == 409


async def test_invalid_inputs_and_unauthenticated_requests_are_rejected(client):
    """Reject invalid coordinates, injected prices, payment details and foreign references."""
    http, db = client
    a = await login(http)
    payload = {'pickup': PICKUP, 'destination': AIRPORT}
    assert (await http.post(BASE + '/quotes', json=payload)).status_code == 401
    for invalid in ({**AIRPORT, 'lat': 19}, {**AIRPORT, 'lng': 'NaN'}, {**AIRPORT, 'name': ' '}, PICKUP):
        assert (await http.post(BASE + '/quotes', headers=a, json={'pickup': PICKUP, 'destination': invalid})).status_code == 422
    quote = await http.post(BASE + '/quotes', headers=a, json=payload)
    assert quote.status_code == 201
    valid = {'quote_id': quote.json()['id'], 'vehicle': 'bike', 'payment': 'card_visa'}
    for invalid in ({**valid, 'vehicle': 'spaceship'}, {**valid, 'payment': 'bitcoin'}, {**valid, 'fare': 1}, {**valid, 'card_number': '4111111111111111'}, {**valid, 'quote_id': {'$ne': ''}}):
        assert (await http.post(BASE + '/rides', headers=a, json=invalid)).status_code == 422
    assert (await http.post(BASE + '/rides', headers=a, json={**valid, 'quote_id': 'invalid'})).status_code == 404
    assert (await http.get(BASE + '/rides/invalid', headers=a)).status_code == 404
    assert (await http.get(BASE + '/rides/' + str(ObjectId()), headers=a)).status_code == 404
    assert (await http.get(BASE + '/rides/' + str(ObjectId()))).status_code == 401
    assert await db.bookings.count_documents({}) == 0
    created = await http.post(BASE + '/rides', headers=a, json=valid)
    assert created.status_code == 201
    doc = await db.bookings.find_one({'_id': ObjectId(created.json()['id'])})
    assert doc['payment'] == 'card_visa' and 'card_number' not in doc


async def test_quote_and_booking_required_fields_and_database_uniqueness(client):
    http, db = client
    headers = await login(http)
    for body in ({}, {'pickup': PICKUP}, {'pickup': PICKUP, 'destination': {**AIRPORT, 'name': 'x' * 151}},
                 {'pickup': {'$ne': None}, 'destination': AIRPORT}):
        assert (await http.post(BASE + '/quotes', headers=headers, json=body)).status_code == 422
    quote = await http.post(BASE + '/quotes', headers=headers, json={'pickup': PICKUP, 'destination': AIRPORT})
    assert quote.status_code == 201
    valid = {'quote_id': quote.json()['id'], 'vehicle': 'bike', 'payment': 'cash'}
    for key in valid:
        assert (await http.post(BASE + '/rides', headers=headers, json={k: v for k, v in valid.items() if k != key})).status_code == 422
    result = await http.post(BASE + '/rides', headers=headers, json=valid)
    assert result.status_code == 201
    doc = await db.bookings.find_one({'_id': ObjectId(result.json()['id'])})
    indexes = await db.bookings.index_information()
    assert any(i.get('unique') and i['key'] == [('quote_id', 1)] for i in indexes.values())
    with pytest.raises(DuplicateKeyError):
        await db.bookings.insert_one({**doc, '_id': ObjectId()})
    assert await db.bookings.count_documents({'quote_id': doc['quote_id']}) == 1


async def test_nested_route_and_parcel_validation_has_no_side_effects(client):
    http, db = client
    headers = await login(http)
    route = {'pickup': PICKUP, 'destination': AIRPORT}
    invalid_routes = [{k: v for k, v in route.items() if k != field} for field in route]
    for side in route:
        for field in ('name', 'lat', 'lng'):
            invalid_routes.append({**route, side: {k: v for k, v in route[side].items() if k != field}})
        for change in ({'name': ''}, {'name': 'x' * 151}, {'lat': 17.199}, {'lat': 17.551},
                       {'lng': 78.299}, {'lng': 78.701}, {'lat': {'$gt': 0}}):
            invalid_routes.append({**route, side: {**route[side], **change}})
    for payload in invalid_routes:
        assert (await http.post(BASE + '/quotes', headers=headers, json=payload)).status_code == 422
    assert await db.quotes.count_documents({}) == 0
    quote = await http.post(BASE + '/quotes', headers=headers, json=route)
    assert quote.status_code == 201
    parcel = {'package_type': 'medium_box', 'recipient_name': 'Recipient',
              'recipient_phone': '9876543210', 'instructions': '', 'courier_vehicle': 'auto_car'}
    body = {'quote_id': quote.json()['id'], 'vehicle': 'parcel', 'payment': 'cash', 'parcel': parcel}
    bad_parcels = [{k: v for k, v in parcel.items() if k != field}
                   for field in ('package_type', 'recipient_name', 'recipient_phone', 'courier_vehicle')]
    bad_parcels += [{**parcel, **change} for change in (
        {'package_type': 'invalid'}, {'recipient_name': ' '}, {'recipient_name': 'x' * 101},
        {'recipient_phone': '1' * 9}, {'recipient_phone': '1' * 16}, {'recipient_phone': {'$ne': ''}},
        {'instructions': 'x' * 501}, {'courier_vehicle': 'invalid'}, {'courier_vehicle': 'two_wheeler'})]
    before = await db.quotes.find_one({'_id': ObjectId(quote.json()['id'])})
    for invalid in bad_parcels:
        assert (await http.post(BASE + '/rides', headers=headers, json={**body, 'parcel': invalid})).status_code == 422
    assert await db.bookings.count_documents({}) == 0
    assert await db.quotes.find_one({'_id': before['_id']}) == before
    result = await http.post(BASE + '/rides', headers=headers, json=body)
    assert result.status_code == 201 and result.json()['parcel'] == parcel


@pytest.mark.parametrize('field', ['recipient_name', 'instructions'])
@pytest.mark.parametrize('value', ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>',
                                  'A\nB', '\tA', 'A\n', 'A\x00B', 'A\x85B'])
async def test_parcel_text_rejects_markup_and_controls_without_booking(client, field, value):
    """Reject unsafe parcel text without creating a booking."""
    http, db = client
    headers = await login(http)
    quote = await http.post(BASE + '/quotes', headers=headers, json={'pickup': PICKUP, 'destination': AIRPORT})
    assert quote.status_code == 201
    parcel = {'package_type': 'document', 'recipient_name': 'Recipient',
              'recipient_phone': '9876543210', 'instructions': 'Leave at desk', 'courier_vehicle': 'two_wheeler'}
    body = {'quote_id': quote.json()['id'], 'vehicle': 'parcel', 'payment': 'cash',
            'parcel': {**parcel, field: value}}
    before = await db.bookings.count_documents({})
    response = await http.post(BASE + '/rides', headers=headers, json=body)
    assert response.status_code == 422
    assert await db.bookings.count_documents({}) == before


async def test_parcel_text_accepts_punctuation_and_persists(client):
    """Preserve ordinary punctuation and Unicode in a successful parcel booking."""
    http, db = client
    headers = await login(http)
    quote = await http.post(BASE + '/quotes', headers=headers, json={'pickup': PICKUP, 'destination': AIRPORT})
    assert quote.status_code == 201
    parcel = {'package_type': 'document', 'recipient_name': "D'Souza-Marie 李",
              'recipient_phone': '9876543210', 'instructions': 'Café & Co., floor 2 / desk #3!',
              'courier_vehicle': 'two_wheeler'}
    response = await http.post(BASE + '/rides', headers=headers, json={
        'quote_id': quote.json()['id'], 'vehicle': 'parcel', 'payment': 'cash', 'parcel': parcel})
    assert response.status_code == 201
    assert response.json()['parcel'] == parcel
    stored = await db.bookings.find_one({'_id': ObjectId(response.json()['id'])})
    assert stored['parcel'] == parcel
