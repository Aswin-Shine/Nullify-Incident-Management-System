"""DB write retry: only transient errors are retried, with growing backoff."""
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.exc import DBAPIError, IntegrityError, InterfaceError, OperationalError

from app.db.retry import is_transient, with_db_retry


def _with_sqlstate(code):
    orig = Exception("driver error")
    orig.sqlstate = code
    return DBAPIError("stmt", {}, orig)


@pytest.mark.parametrize("exc", [
    OperationalError("stmt", {}, Exception("connection reset")),
    InterfaceError("stmt", {}, Exception("connection closed")),
    DBAPIError("stmt", {}, Exception("gone"), connection_invalidated=True),
    _with_sqlstate("40001"),  # serialization failure
    _with_sqlstate("40P01"),  # deadlock
    _with_sqlstate("57P01"),  # admin shutdown (failover)
    _with_sqlstate("08006"),  # connection failure
    ConnectionError("refused"),
    TimeoutError(),
])
def test_transient_errors_are_retryable(exc):
    assert is_transient(exc)


@pytest.mark.parametrize("exc", [
    IntegrityError("stmt", {}, Exception("duplicate key")),
    _with_sqlstate("23505"),
    ValueError("bad input"),
])
def test_permanent_errors_are_not_retryable(exc):
    assert not is_transient(exc)


def _flaky(failures, exc):
    calls = []

    async def fn():
        calls.append(1)
        if len(calls) <= failures:
            raise exc
        return "done"
    return fn, calls


@patch("app.db.retry.asyncio.sleep", new_callable=AsyncMock)
async def test_succeeds_after_transient_failures(sleep):
    fn, calls = _flaky(2, OperationalError("stmt", {}, Exception("blip")))

    assert await with_db_retry(fn, attempts=3, base_delay=0.1) == "done"
    assert len(calls) == 3


@patch("app.db.retry.asyncio.sleep", new_callable=AsyncMock)
async def test_gives_up_after_attempts(sleep):
    fn, calls = _flaky(99, OperationalError("stmt", {}, Exception("down")))

    with pytest.raises(OperationalError):
        await with_db_retry(fn, attempts=3, base_delay=0.1)
    assert len(calls) == 3


@patch("app.db.retry.asyncio.sleep", new_callable=AsyncMock)
async def test_permanent_error_is_not_retried(sleep):
    fn, calls = _flaky(99, IntegrityError("stmt", {}, Exception("dup")))

    with pytest.raises(IntegrityError):
        await with_db_retry(fn, attempts=3, base_delay=0.1)
    assert len(calls) == 1
    sleep.assert_not_awaited()


@patch("app.db.retry.asyncio.sleep", new_callable=AsyncMock)
async def test_backoff_grows_between_attempts(sleep):
    fn, _ = _flaky(3, OperationalError("stmt", {}, Exception("blip")))

    await with_db_retry(fn, attempts=4, base_delay=0.1)

    delays = [c.args[0] for c in sleep.await_args_list]
    assert len(delays) == 3
    assert delays[0] < delays[1] < delays[2]
