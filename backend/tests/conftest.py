"""Ensure PyMongo's closed-client background tasks finish before loop teardown."""
import asyncio

import pytest


@pytest.fixture(autouse=True)
async def wait_for_closed_mongo_tasks():
    """Let PyMongo 4.11 executors stop after the client fixtures close."""
    yield
    tasks = [task for task in asyncio.all_tasks()
             if task is not asyncio.current_task() and task.get_name().startswith('pymongo_')]
    if tasks:
        await asyncio.wait_for(asyncio.gather(*tasks), timeout=10)
