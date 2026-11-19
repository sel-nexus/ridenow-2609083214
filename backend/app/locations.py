"""Hyderabad location catalogue and owner-scoped saved places."""
from typing import Annotated

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from pymongo.asynchronous.database import AsyncDatabase

from app.core import current_user, database

router = APIRouter(prefix='/api/v1/locations', tags=['locations'])

# Names and approximate coordinates are copied from the product's Hyderabad dataset.
_DATA = [
    ('Cyber Towers, Hitec City', 17.4504, 78.3808),
    ('Mindspace IT Park, Madhapur', 17.4401, 78.3806),
    ('DLF Cyber City, Gachibowli', 17.4486, 78.3585),
    ('Financial District, Nanakramguda', 17.4147, 78.3444),
    ('T-Hub Phase 2, Knowledge City, Raidurg', 17.4325, 78.3758),
    ('Amazon Hyderabad Campus, Financial District', 17.4190, 78.3415),
    ('Google Office, DivyaSree Omega, Kondapur', 17.4642, 78.3582),
    ('Rajiv Gandhi International Airport (RGIA), Shamshabad', 17.2403, 78.4294),
    ('Secunderabad Railway Station', 17.4344, 78.5017),
    ('Hyderabad Deccan Railway Station, Nampally', 17.3923, 78.4697),
    ('Kacheguda Railway Station', 17.3892, 78.4988),
    ('JBS, Jubilee Bus Station, Secunderabad', 17.4519, 78.4975),
    ('MGBS, Mahatma Gandhi Bus Station, Imlibun', 17.3789, 78.4837),
    ('Hitec City Metro Station', 17.4475, 78.3822),
    ('Ameerpet Metro Interchange', 17.4358, 78.4447),
    ('Inorbit Mall, Hitec City', 17.4359, 78.3888),
    ('Sarath City Capital Mall, Kondapur', 17.4580, 78.3619),
    ('Forum Sujana Mall, Kukatpally', 17.4851, 78.3883),
    ('GVK One Mall, Banjara Hills Road No. 1', 17.4194, 78.4484),
    ('Next Galleria Mall, Punjagutta', 17.4278, 78.4516),
    ('IKEA Hyderabad, Hitec City', 17.4373, 78.3754),
    ('Charminar, Old City', 17.3616, 78.4747),
    ('Golconda Fort, Ibrahim Bagh', 17.3833, 78.4011),
    ('Hussain Sagar Lake / Tank Bund / Buddha Statue', 17.4239, 78.4738),
    ('Birla Mandir, Naubat Pahad', 17.4062, 78.4691),
    ('Salar Jung Museum, Darulshifa', 17.3713, 78.4804),
    ('Qutb Shahi Tombs, Ibrahim Bagh', 17.3934, 78.3963),
    ('Ramoji Film City, Hayathnagar', 17.3123, 78.6821),
    ('Durgam Cheruvu Cable Bridge, Jubilee Hills/Madhapur', 17.4312, 78.3899),
    ('Jubilee Hills Check Post / Road No. 36', 17.4319, 78.4073),
    ('Banjara Hills Road No. 12', 17.4156, 78.4350),
    ('Madhapur Main Road', 17.4483, 78.3915),
    ('Kondapur Junction', 17.4699, 78.3578),
    ('Ameerpet Cross Roads', 17.4375, 78.4483),
    ('Begumpet Airport Road', 17.4447, 78.4674),
    ('Kukatpally Housing Board (KPHB) Colony', 17.4933, 78.3994),
    ('Mehdipatnam Bus Depot', 17.3917, 78.4398),
    ('Dilsukhnagar Metro Station', 17.3688, 78.5247),
    ('Gachibowli Stadium / ORR Junction', 17.4462, 78.3475),
    ('Apollo Hospitals, Jubilee Hills', 17.4150, 78.4124),
    ('Yashoda Hospitals, Somajiguda', 17.4262, 78.4552),
    ('AIG Hospitals, Gachibowli', 17.4411, 78.3678),
    ('KIMS Hospital, Secunderabad', 17.4385, 78.4854),
    ('University of Hyderabad (HCU), Gachibowli', 17.4601, 78.3315),
    ('IIIT Hyderabad, Gachibowli', 17.4455, 78.3489),
    ('Osmania University Campus, Amberpet', 17.4140, 78.5284),
]


class Location(BaseModel):
    """Represent a named point within the Hyderabad metro area."""
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True, allow_inf_nan=False)
    name: str = Field(min_length=1, max_length=150)
    lat: float = Field(ge=17.20, le=17.55)
    lng: float = Field(ge=78.30, le=78.70)


class SavedInput(Location):
    """Validate a place label and its destination."""
    label: str = Field(min_length=1, max_length=40, pattern=r'^[\w .-]+$')


class SavedPlace(SavedInput):
    """Expose a saved place without its owner identifier."""
    id: str


class SavedRepository:
    """Read and write places only within the authenticated owner."""
    def __init__(self, db: AsyncDatabase) -> None:
        self.collection = db.saved_locations

    async def list(self, owner: ObjectId, limit: int, offset: int) -> tuple[list[dict], int]:
        """List a bounded page and its total."""
        query = {'owner': owner}
        total = await self.collection.count_documents(query)
        docs = await self.collection.find(query).sort('_id', 1).skip(offset).limit(limit).to_list(length=limit)
        return docs, total

    async def save(self, owner: ObjectId, payload: SavedInput) -> dict:
        """Upsert one case-insensitive label per owner."""
        key = payload.label.casefold()
        await self.collection.update_one({'owner': owner, 'label_key': key}, {'$set': payload.model_dump()}, upsert=True)
        return await self.collection.find_one({'owner': owner, 'label_key': key})

    async def delete(self, owner: ObjectId, place_id: ObjectId) -> bool:
        """Delete only a place belonging to the owner."""
        result = await self.collection.delete_one({'_id': place_id, 'owner': owner})
        return result.deleted_count == 1


def public_place(doc: dict) -> SavedPlace:
    """Remove Mongo-only fields from a saved place."""
    return SavedPlace(id=str(doc['_id']), **{key: doc[key] for key in ('label', 'name', 'lat', 'lng')})


@router.get('/search')
async def search(q: Annotated[str, Query(max_length=100)] = '', limit: Annotated[int, Query(ge=1, le=50)] = 10, offset: Annotated[int, Query(ge=0, le=10000)] = 0, user: dict = Depends(current_user)) -> dict:
    """Find case-insensitive literal matches in the bounded catalogue."""
    query = q.strip().casefold()
    results = [Location(name=name, lat=lat, lng=lng) for name, lat, lng in _DATA if query in name.casefold()]
    return {'items': results[offset:offset + limit], 'total': len(results)}


@router.get('/saved')
async def saved(request: Request, user: Annotated[dict, Depends(current_user)], limit: Annotated[int, Query(ge=1, le=50)] = 50, offset: Annotated[int, Query(ge=0, le=10000)] = 0) -> dict:
    """List the current rider's saved locations."""
    docs, total = await SavedRepository(database(request)).list(user['_id'], limit, offset)
    return {'items': [public_place(doc) for doc in docs], 'total': total}


@router.put('/saved', response_model=SavedPlace)
async def save_place(payload: SavedInput, request: Request, user: Annotated[dict, Depends(current_user)]) -> SavedPlace:
    """Create or replace a named place for the current rider."""
    return public_place(await SavedRepository(database(request)).save(user['_id'], payload))


@router.delete('/saved/{place_id}', status_code=204)
async def delete_place(place_id: str, request: Request, user: Annotated[dict, Depends(current_user)]) -> None:
    """Remove an owned saved place or return not found."""
    try:
        oid = ObjectId(place_id)
    except InvalidId:
        raise HTTPException(status_code=404, detail='Saved place not found')
    if not await SavedRepository(database(request)).delete(user['_id'], oid):
        raise HTTPException(status_code=404, detail='Saved place not found')
