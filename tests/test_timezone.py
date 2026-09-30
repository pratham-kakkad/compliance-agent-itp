"""Organization time zone (Settings) and import time zone.

Punches are stored as UTC instants. The organization zone (app_settings,
default settings.default_timezone) decides which calendar day a punch
belongs to and how every time is shown by the assistant; the uploader picks
the zone naive file times are read in.
"""
import csv
import hashlib
import importlib.util
import io
import logging
import math
import re
import socket
import threading
import uuid
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from langchain_core.embeddings import Embeddings
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, SystemMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from openpyxl import Workbook
from sqlalchemy import delete, func, select, text

import app.attendance.importer as importer_module
import app.chat.attendance_index as index_module
import app.chat.embeddings as embeddings_module
from app import analytics
from app.attendance import rules
from app.attendance.importer import import_punch_log
from app.attendance.models import AttendanceDay, AttendanceEmployee, BiometricPunchLog, ImportBatch
from app.chat.agent import answer, system_prompt
from app.chat.attendance_docs import attendance_fingerprint, build_attendance_documents
from app.chat.attendance_index import attendance_index
from app.chat.attendance_tools import build_attendance_tools
from app.config import settings
from app.models import Attendance, MeetingOccurrence, MeetingSeries, OrgUser
from app.org_settings import service
from app.org_settings.models import AppSetting
from tests.conftest import login_as

AVA = "ava.martinez@corp.com"
HEADER = ["Log Date", "Device", "Emp Code", "Name", "Company", "Department"]
IST = ZoneInfo("Asia/Kolkata")
NY = ZoneInfo("America/New_York")
LA = ZoneInfo("America/Los_Angeles")

_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost", "0.0.0.0", None}


# --------------------------------------------------------------------------
# Fixtures and helpers
# --------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Any attempt to reach a non-local host fails the test loudly."""
    real_connect = socket.socket.connect
    real_getaddrinfo = socket.getaddrinfo
    af_unix = getattr(socket, "AF_UNIX", None)

    def guarded_connect(self, address):
        host = address[0] if isinstance(address, tuple) else address
        if (af_unix is not None and self.family == af_unix) or host in _LOCAL_HOSTS:
            return real_connect(self, address)
        raise AssertionError(f"test tried to open a network connection to {address!r}")

    def guarded_getaddrinfo(host, *args, **kwargs):
        if host in _LOCAL_HOSTS:
            return real_getaddrinfo(host, *args, **kwargs)
        raise AssertionError(f"test tried to resolve {host!r}")

    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    monkeypatch.setattr(socket, "getaddrinfo", guarded_getaddrinfo)


@pytest.fixture(autouse=True)
def utc_default_and_clean_index(monkeypatch):
    """Every test starts from the documented default (UTC, whatever the
    developer's .env says), with no real keys and a fresh assistant index."""
    monkeypatch.setattr(settings, "default_timezone", "UTC")
    monkeypatch.setattr(settings, "groq_api_key", "")
    monkeypatch.setattr(settings, "huggingfacehub_api_token", "")
    attendance_index.reset()
    yield
    attendance_index.reset()


def utc(y, mo, d, h=0, mi=0) -> datetime:
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc)


def _csv(rows: list[list]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(HEADER)
    writer.writerows(rows)
    return buf.getvalue().encode("utf-8")


def _row(stamp: str, code: str = "TZ1", name: str | None = None, device: str = "Entry", dept: str = "Eng") -> list:
    return [stamp, device, code, name or f"Person {code}", "Acme", dept]


def _import(db, rows: list[list], tz: str | None = None, filename: str = "t.csv"):
    result = import_punch_log(db, filename, _csv(rows), imported_by="tester@corp.com", source_timezone=tz)
    assert result.rejected == [], result.rejected
    return result


def _punches(db, code: str) -> list[datetime]:
    return sorted(db.scalars(select(BiometricPunchLog.log_date).where(BiometricPunchLog.emp_code == code)))


def _days(db, code: str) -> dict[date, tuple]:
    rows = db.scalars(select(AttendanceDay).where(AttendanceDay.emp_code == code)).all()
    return {r.work_date: (r.first_punch, r.last_punch, r.punch_count) for r in rows}


def _all_days(db) -> dict[tuple[str, date], tuple]:
    return {
        (r.emp_code, r.work_date): (r.first_punch, r.last_punch, r.punch_count)
        for r in db.scalars(select(AttendanceDay)).all()
    }


def _assert_days_match_punches(db, tz) -> None:
    """Every AttendanceDay is exactly what the raw punches give in `tz`:
    no stale rows, no missing rows, right first/last/count."""
    expected: dict[tuple[str, date], list[datetime]] = {}
    for code, ts in db.execute(select(BiometricPunchLog.emp_code, BiometricPunchLog.log_date)).all():
        expected.setdefault((code, ts.astimezone(tz).date()), []).append(ts)
    assert _all_days(db) == {k: (min(v), max(v), len(v)) for k, v in expected.items()}


def _counts(db) -> tuple[int, int, int, int, int]:
    return tuple(
        db.scalar(select(func.count()).select_from(model))
        for model in (ImportBatch, BiometricPunchLog, AttendanceEmployee, AttendanceDay, AppSetting)
    )


def _set_org_zone(db, name: str) -> dict:
    return service.set_timezone(db, name, updated_by="tester@corp.com")


def _row_dicts(result: dict, key: str, columns_key: str) -> list[dict]:
    columns = [c.strip() for c in result[columns_key].strip("[]").split(",")]
    return [dict(zip(columns, row)) for row in result[key]]


def _offset_minutes(label: str) -> int:
    sign = -1 if label[0] == "-" else 1
    hours, minutes = label[1:].split(":")
    return sign * (int(hours) * 60 + int(minutes))


class _Spy:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, *args, **kwargs) -> None:
        self.calls += 1


# --------------------------------------------------------------------------
# validate_timezone / list_timezones / utc_offset_label
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name", ["UTC", "Asia/Kolkata", "America/New_York", "Europe/London", "Asia/Kathmandu", "Etc/GMT+12"]
)
def test_validate_timezone_accepts_iana_names(name):
    assert service.validate_timezone(name) == name


def test_validate_timezone_strips_whitespace():
    assert service.validate_timezone("  Asia/Kolkata\t") == "Asia/Kolkata"


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "   ",
        "Mars/Olympus",
        "../etc/passwd",
        "/etc/localtime",
        "posix/Asia/Kolkata",
        "right/UTC",
        "localtime",
        "Factory",
        "Asia/Kolkata/../../x",
        "Asia/Kolkata\x00",
    ],
)
def test_validate_timezone_rejects_unknown_and_pseudo_zones(bad):
    with pytest.raises(ValueError) as exc:
        service.validate_timezone(bad)
    assert "Unknown time zone" in str(exc.value)


def test_validate_timezone_message_names_the_zone():
    with pytest.raises(ValueError, match=r"^Unknown time zone 'Mars/Olympus'$"):
        service.validate_timezone("Mars/Olympus")


@pytest.mark.parametrize("bad", [None, 123, 5.5, ["UTC"], {"zone": "UTC"}, b"UTC"])
def test_validate_timezone_rejects_non_strings_with_value_error(bad):
    with pytest.raises(ValueError):
        service.validate_timezone(bad)


def test_list_timezones_shape_labels_and_order():
    zones = service.list_timezones()
    names = [z["name"] for z in zones]

    assert 300 <= len(zones) <= 1000
    assert len(set(names)) == len(names)
    assert {"UTC", "Asia/Kolkata", "America/New_York", "Pacific/Kiritimati", "Etc/GMT+12"} <= set(names)
    assert not [n for n in names if n.startswith(("posix/", "right/")) or n in ("localtime", "Factory")]

    for z in zones:
        assert set(z) == {"name", "offset", "label"}
        assert re.fullmatch(r"[+-]\d\d:\d\d", z["offset"]), z
        assert z["label"] == f"(UTC{z['offset']}) {z['name']}"
        assert service.validate_timezone(z["name"]) == z["name"]  # everything listed is accepted

    assert next(z for z in zones if z["name"] == "Asia/Kolkata") == {
        "name": "Asia/Kolkata",
        "offset": "+05:30",
        "label": "(UTC+05:30) Asia/Kolkata",
    }
    assert next(z for z in zones if z["name"] == "UTC")["offset"] == "+00:00"
    # Offsets are the zone's *current* offset (DST-aware).
    ny = next(z for z in zones if z["name"] == "America/New_York")
    assert _offset_minutes(ny["offset"]) * 60 == datetime.now(NY).utcoffset().total_seconds()

    keys = [(_offset_minutes(z["offset"]), z["name"]) for z in zones]
    assert keys == sorted(keys)
    assert keys[0][0] == -12 * 60 and keys[-1][0] == 14 * 60


def test_utc_offset_label():
    assert service.utc_offset_label("UTC") == "+00:00"
    assert service.utc_offset_label("Asia/Kolkata") == "+05:30"
    assert service.utc_offset_label("Asia/Kathmandu") == "+05:45"
    assert service.utc_offset_label("America/New_York", utc(2026, 1, 15, 12)) == "-05:00"
    assert service.utc_offset_label("America/New_York", utc(2026, 7, 15, 12)) == "-04:00"
    assert service.utc_offset_label("America/St_Johns", utc(2026, 1, 15, 12)) == "-03:30"
    assert service.utc_offset_label("Pacific/Kiritimati") == "+14:00"
    assert service.utc_offset_label("Etc/GMT+12") == "-12:00"


# --------------------------------------------------------------------------
# get_timezone_name defaults and fallbacks
# --------------------------------------------------------------------------


def test_org_zone_defaults_to_env_default(db_session, monkeypatch):
    assert db_session.get(AppSetting, service.TIMEZONE_KEY) is None
    assert service.get_timezone_name(db_session) == "UTC"

    monkeypatch.setattr(settings, "default_timezone", "Asia/Kolkata")
    assert service.get_timezone_name(db_session) == "Asia/Kolkata"
    assert service.get_timezone(db_session) == IST
    assert service.org_today(db_session) == datetime.now(IST).date()
    assert service.get_settings(db_session) == {
        "timezone": "Asia/Kolkata",
        "timezone_offset": "+05:30",
        "default_timezone": "Asia/Kolkata",
        "updated_at": None,
        "updated_by": None,
    }


def test_saved_zone_wins_over_env_default(db_session, monkeypatch):
    monkeypatch.setattr(settings, "default_timezone", "America/New_York")
    _set_org_zone(db_session, "Asia/Kolkata")
    assert service.get_timezone_name(db_session) == "Asia/Kolkata"
    assert service.get_settings(db_session)["default_timezone"] == "America/New_York"


def test_invalid_env_default_falls_back_to_utc(db_session, monkeypatch):
    monkeypatch.setattr(settings, "default_timezone", "Not/AZone")
    assert service.get_timezone_name(db_session) == "UTC"
    assert service.get_settings(db_session)["default_timezone"] == "UTC"
    monkeypatch.setattr(settings, "default_timezone", "")
    assert service.get_timezone_name(db_session) == "UTC"


@pytest.mark.parametrize("stored", ["Mars/Olympus", "", {"zone": "Asia/Kolkata"}, 42])
def test_invalid_saved_zone_falls_back_with_warning(db_session, monkeypatch, caplog, stored):
    monkeypatch.setattr(settings, "default_timezone", "America/New_York")
    db_session.add(AppSetting(key=service.TIMEZONE_KEY, value=stored, updated_by="someone"))
    db_session.flush()

    with caplog.at_level(logging.WARNING):
        assert service.get_timezone_name(db_session) == "America/New_York"
        settings_body = service.get_settings(db_session)
    assert settings_body["timezone"] == "America/New_York"
    assert any(r.levelno == logging.WARNING for r in caplog.records)


# --------------------------------------------------------------------------
# Importer: source time zone
# --------------------------------------------------------------------------


def test_naive_csv_time_is_read_in_source_zone_and_stored_as_utc(db_session):
    result = _import(db_session, [_row("22-09-2026 09:02", "TZ1")], tz="Asia/Kolkata")

    assert result.source_timezone == "Asia/Kolkata"
    [punch] = _punches(db_session, "TZ1")
    assert punch == utc(2026, 9, 22, 3, 32)
    assert punch.utcoffset() == timedelta(0)

    batch = db_session.get(ImportBatch, uuid.UUID(result.batch_id))
    assert batch.source_timezone == "Asia/Kolkata"

    # Org zone is still UTC, so the day is the UTC date.
    assert _days(db_session, "TZ1") == {date(2026, 9, 22): (utc(2026, 9, 22, 3, 32), utc(2026, 9, 22, 3, 32), 1)}


def test_source_zone_defaults_to_env_default_org_zone(db_session, monkeypatch):
    monkeypatch.setattr(settings, "default_timezone", "America/New_York")
    result = _import(db_session, [_row("22-09-2026 09:02", "TZ2")])
    assert result.source_timezone == "America/New_York"
    assert db_session.get(ImportBatch, uuid.UUID(result.batch_id)).source_timezone == "America/New_York"
    assert _punches(db_session, "TZ2") == [utc(2026, 9, 22, 13, 2)]  # EDT = UTC-4


@pytest.mark.parametrize("picker", [None, "", "   "])
def test_source_zone_defaults_to_saved_org_zone(db_session, picker):
    _set_org_zone(db_session, "Asia/Kolkata")
    result = _import(db_session, [_row("22-09-2026 09:02", "TZ3")], tz=picker)
    assert result.source_timezone == "Asia/Kolkata"
    assert db_session.get(ImportBatch, uuid.UUID(result.batch_id)).source_timezone == "Asia/Kolkata"
    assert _punches(db_session, "TZ3") == [utc(2026, 9, 22, 3, 32)]


def test_source_zone_is_stripped(db_session):
    result = _import(db_session, [_row("22-09-2026 09:02", "TZ4")], tz="  Asia/Kolkata ")
    assert result.source_timezone == "Asia/Kolkata"
    assert _punches(db_session, "TZ4") == [utc(2026, 9, 22, 3, 32)]


def test_explicit_offsets_in_the_file_win_over_the_picker(db_session):
    _import(
        db_session,
        [
            _row("2026-09-22T09:02:00+05:30", "OFF1"),
            _row("2026-09-22T03:40:00Z", "OFF2"),
            _row("22-09-2026 10:00 +05:30", "OFF3"),
            _row("2026-09-22T09:02:00-07:00", "OFF4"),
            _row("22-09-2026 09:02", "OFF5"),  # naive: the picker applies
        ],
        tz="America/New_York",
    )
    assert _punches(db_session, "OFF1") == [utc(2026, 9, 22, 3, 32)]
    assert _punches(db_session, "OFF2") == [utc(2026, 9, 22, 3, 40)]
    assert _punches(db_session, "OFF3") == [utc(2026, 9, 22, 4, 30)]
    assert _punches(db_session, "OFF4") == [utc(2026, 9, 22, 16, 2)]
    assert _punches(db_session, "OFF5") == [utc(2026, 9, 22, 13, 2)]


def test_iso_timestamps_are_read_year_month_day(db_session):
    # Day <= 12: an ISO date must not be read day-first (5 Sep, not 9 May).
    _import(
        db_session,
        [
            _row("2026-09-05T09:02:00+05:30", "ISO1"),
            _row("2026-03-04T08:00:00Z", "ISO2"),
            _row("2026-09-05 09:02", "ISO3"),
        ],
        tz="Asia/Kolkata",
    )
    assert _punches(db_session, "ISO1") == [utc(2026, 9, 5, 3, 32)]
    assert _punches(db_session, "ISO2") == [utc(2026, 3, 4, 8, 0)]
    assert _punches(db_session, "ISO3") == [utc(2026, 9, 5, 3, 32)]


def test_day_first_dates_still_day_first(db_session):
    _import(db_session, [_row("03-04-2026 09:00", "DF1")], tz="UTC")
    assert _punches(db_session, "DF1") == [utc(2026, 4, 3, 9, 0)]


def test_xlsx_naive_datetime_cells_are_localized(db_session):
    wb = Workbook()
    ws = wb.active
    ws.append(HEADER)
    ws.append([datetime(2026, 9, 22, 9, 2), "Entry", "XL1", "Xl One", "Acme", "Eng"])
    ws.append(["22-09-2026 18:30", "Exit", "XL1", "Xl One", "Acme", "Eng"])  # text cell
    buf = io.BytesIO()
    wb.save(buf)

    result = import_punch_log(
        db_session, "punches.xlsx", buf.getvalue(), imported_by="tester@corp.com", source_timezone="Asia/Kolkata"
    )
    assert result.rejected == [] and result.accepted == 2
    assert result.source_timezone == "Asia/Kolkata"
    first, second = _punches(db_session, "XL1")
    assert abs(first - utc(2026, 9, 22, 3, 32)) < timedelta(seconds=1)
    assert second == utc(2026, 9, 22, 13, 0)


def test_dst_gap_and_overlap_are_deterministic(db_session, monkeypatch):
    monkeypatch.setattr(settings, "default_timezone", "America/New_York")
    rows = [
        _row("08-03-2026 01:59", "DST1"),  # EST
        _row("08-03-2026 02:30", "DST1"),  # does not exist (spring forward)
        _row("08-03-2026 03:00", "DST1"),  # EDT
        _row("01-11-2026 00:59", "DST2"),  # EDT
        _row("01-11-2026 01:30", "DST2"),  # happens twice (fall back): fold=0 = first, EDT
        _row("01-11-2026 02:00", "DST2"),  # EST
    ]
    result = _import(db_session, rows, tz="America/New_York")
    assert result.accepted == 6

    assert _punches(db_session, "DST1") == [utc(2026, 3, 8, 6, 59), utc(2026, 3, 8, 7, 0), utc(2026, 3, 8, 7, 30)]
    assert _punches(db_session, "DST2") == [utc(2026, 11, 1, 4, 59), utc(2026, 11, 1, 5, 30), utc(2026, 11, 1, 7, 0)]

    # Days are dated in the org zone (New York): one day each, 3 punches.
    assert _days(db_session, "DST1") == {date(2026, 3, 8): (utc(2026, 3, 8, 6, 59), utc(2026, 3, 8, 7, 30), 3)}
    assert _days(db_session, "DST2") == {date(2026, 11, 1): (utc(2026, 11, 1, 4, 59), utc(2026, 11, 1, 7, 0), 3)}

    # Importing the same file again gives the same instants.
    _import(db_session, rows, tz="America/New_York")
    assert _punches(db_session, "DST2") == sorted(
        [utc(2026, 11, 1, 4, 59), utc(2026, 11, 1, 5, 30), utc(2026, 11, 1, 7, 0)] * 2
    )


@pytest.mark.parametrize("bad", ["Mars/Olympus", "posix/Asia/Kolkata", "../etc/passwd", "localtime"])
def test_invalid_source_zone_raises_and_writes_nothing(db_session, bad):
    _import(db_session, [_row("21-09-2026 09:00", "PRE1")], tz="UTC")  # something already there
    before = _counts(db_session)

    with pytest.raises(ValueError, match="Unknown time zone"):
        import_punch_log(
            db_session, "t.csv", _csv([_row("22-09-2026 09:02", "BAD1")]), imported_by="t", source_timezone=bad
        )

    db_session.rollback()  # whatever might have been pending must not have been flushed/committed
    assert _counts(db_session) == before
    assert db_session.get(AttendanceEmployee, "BAD1") is None


# --------------------------------------------------------------------------
# Attendance days are dated in the org zone
# --------------------------------------------------------------------------


def test_ist_evening_utc_punch_belongs_to_next_local_day(db_session):
    _set_org_zone(db_session, "Asia/Kolkata")
    result = _import(db_session, [_row("22-09-2026 20:00", "IST1")], tz="UTC")
    assert result.source_timezone == "UTC"
    assert _days(db_session, "IST1") == {date(2026, 9, 23): (utc(2026, 9, 22, 20), utc(2026, 9, 22, 20), 1)}


def test_ist_two_utc_dates_one_local_day_across_imports(db_session):
    _set_org_zone(db_session, "Asia/Kolkata")
    # 00:30 IST on the 23rd (UTC 22nd), then 15:30 IST on the 23rd (UTC 23rd), in separate imports.
    _import(db_session, [_row("22-09-2026 19:00", "IST2")], tz="UTC")
    _import(db_session, [_row("23-09-2026 10:00", "IST2")], tz="UTC")
    assert _days(db_session, "IST2") == {date(2026, 9, 23): (utc(2026, 9, 22, 19), utc(2026, 9, 23, 10), 2)}
    _assert_days_match_punches(db_session, IST)


def test_ist_one_utc_date_two_local_days(db_session):
    _set_org_zone(db_session, "Asia/Kolkata")
    _import(db_session, [_row("22-09-2026 10:00", "IST3"), _row("22-09-2026 19:00", "IST3")], tz="UTC")
    assert _days(db_session, "IST3") == {
        date(2026, 9, 22): (utc(2026, 9, 22, 10), utc(2026, 9, 22, 10), 1),
        date(2026, 9, 23): (utc(2026, 9, 22, 19), utc(2026, 9, 22, 19), 1),
    }


def test_los_angeles_opposite_boundary(db_session):
    _set_org_zone(db_session, "America/Los_Angeles")  # PDT, UTC-7
    # 20:00 PDT on the 22nd is 03:00 UTC on the 23rd; imported first.
    _import(db_session, [_row("23-09-2026 03:00", "LA1")], tz="UTC")
    # 09:00 PDT on the 22nd (UTC 22nd) and 23:00 PDT on the 21st (UTC 22nd 06:00).
    _import(db_session, [_row("22-09-2026 16:00", "LA1"), _row("22-09-2026 06:00", "LA1")], tz="UTC")
    assert _days(db_session, "LA1") == {
        date(2026, 9, 21): (utc(2026, 9, 22, 6), utc(2026, 9, 22, 6), 1),
        date(2026, 9, 22): (utc(2026, 9, 22, 16), utc(2026, 9, 23, 3), 2),
    }
    _assert_days_match_punches(db_session, LA)


def test_local_file_times_land_on_their_local_day(db_session):
    # Org zone and file zone both IST: a 01:30 local punch is that local day.
    _set_org_zone(db_session, "Asia/Kolkata")
    _import(db_session, [_row("23-09-2026 01:30", "IST4"), _row("23-09-2026 23:50", "IST4")])
    assert _days(db_session, "IST4") == {date(2026, 9, 23): (utc(2026, 9, 22, 20), utc(2026, 9, 23, 18, 20), 2)}


def test_day_grouping_does_not_depend_on_the_database_session_zone(db_session):
    # Only this test transaction's session zone changes (SET LOCAL, rolled back).
    db_session.execute(text("SET LOCAL TIME ZONE 'America/Los_Angeles'"))
    _set_org_zone(db_session, "Asia/Kolkata")
    _import(db_session, [_row("22-09-2026 20:00", "SES1"), _row("22-09-2026 10:00", "SES1")], tz="UTC")
    assert _days(db_session, "SES1") == {
        date(2026, 9, 22): (utc(2026, 9, 22, 10), utc(2026, 9, 22, 10), 1),
        date(2026, 9, 23): (utc(2026, 9, 22, 20), utc(2026, 9, 22, 20), 1),
    }
    _assert_days_match_punches(db_session, IST)


# --------------------------------------------------------------------------
# recompute_days / recompute_all_days / set_timezone
# --------------------------------------------------------------------------

_MOVE_ROWS = [
    _row("22-09-2026 10:00", "MV1"),  # UTC 22nd; IST 22nd 15:30; LA 22nd 03:00
    _row("22-09-2026 20:00", "MV1"),  # UTC 22nd; IST 23rd 01:30; LA 22nd 13:00
    _row("22-09-2026 21:00", "MV2"),  # UTC 22nd; IST 23rd 02:30; LA 22nd 14:00
    _row("23-09-2026 02:00", "MV2"),  # UTC 23rd; IST 23rd 07:30; LA 22nd 19:00
    _row("24-09-2026 12:00", "MV3"),  # 24th everywhere
]
_MOVE_UTC = {
    ("MV1", date(2026, 9, 22)): (utc(2026, 9, 22, 10), utc(2026, 9, 22, 20), 2),
    ("MV2", date(2026, 9, 22)): (utc(2026, 9, 22, 21), utc(2026, 9, 22, 21), 1),
    ("MV2", date(2026, 9, 23)): (utc(2026, 9, 23, 2), utc(2026, 9, 23, 2), 1),
    ("MV3", date(2026, 9, 24)): (utc(2026, 9, 24, 12), utc(2026, 9, 24, 12), 1),
}
_MOVE_IST = {
    ("MV1", date(2026, 9, 22)): (utc(2026, 9, 22, 10), utc(2026, 9, 22, 10), 1),
    ("MV1", date(2026, 9, 23)): (utc(2026, 9, 22, 20), utc(2026, 9, 22, 20), 1),
    ("MV2", date(2026, 9, 23)): (utc(2026, 9, 22, 21), utc(2026, 9, 23, 2), 2),
    ("MV3", date(2026, 9, 24)): (utc(2026, 9, 24, 12), utc(2026, 9, 24, 12), 1),
}
_MOVE_LA = {
    ("MV1", date(2026, 9, 22)): (utc(2026, 9, 22, 10), utc(2026, 9, 22, 20), 2),
    ("MV2", date(2026, 9, 22)): (utc(2026, 9, 22, 21), utc(2026, 9, 23, 2), 2),
    ("MV3", date(2026, 9, 24)): (utc(2026, 9, 24, 12), utc(2026, 9, 24, 12), 1),
}


def test_changing_org_zone_moves_days_with_no_stale_rows(db_session):
    _import(db_session, _MOVE_ROWS, tz="UTC")
    assert _all_days(db_session) == _MOVE_UTC
    untouched_id = db_session.scalar(select(AttendanceDay.id).where(AttendanceDay.emp_code == "MV3"))

    result = _set_org_zone(db_session, "Asia/Kolkata")
    assert result["changed"] is True
    assert result["timezone"] == "Asia/Kolkata"
    assert result["timezone_offset"] == "+05:30"
    assert result["updated_by"] == "tester@corp.com"
    assert result["updated_at"] is not None
    assert result["recomputed_days"] == db_session.scalar(select(func.count()).select_from(AttendanceDay)) == 4
    assert _all_days(db_session) == _MOVE_IST
    assert service.get_timezone_name(db_session) == "Asia/Kolkata"
    # An unchanged day keeps its row.
    assert db_session.scalar(select(AttendanceDay.id).where(AttendanceDay.emp_code == "MV3")) == untouched_id

    result = _set_org_zone(db_session, "America/Los_Angeles")
    assert result["changed"] is True and result["recomputed_days"] == 3
    assert _all_days(db_session) == _MOVE_LA

    result = _set_org_zone(db_session, "UTC")
    assert result["changed"] is True and result["recomputed_days"] == 4
    assert _all_days(db_session) == _MOVE_UTC


def test_new_import_after_zone_change_uses_new_zone_and_merges_with_moved_days(db_session):
    _import(db_session, [_row("22-09-2026 20:00", "MG1")], tz="UTC")  # UTC day 22nd
    _set_org_zone(db_session, "Asia/Kolkata")  # -> IST day 23rd
    _import(db_session, [_row("23-09-2026 09:00", "MG1")], tz="Asia/Kolkata")  # IST 23rd 09:00 = 03:30Z
    assert _days(db_session, "MG1") == {date(2026, 9, 23): (utc(2026, 9, 22, 20), utc(2026, 9, 23, 3, 30), 2)}
    _assert_days_match_punches(db_session, IST)


def test_set_same_zone_again_is_a_no_op(db_session, monkeypatch):
    _import(db_session, _MOVE_ROWS, tz="UTC")
    _set_org_zone(db_session, "Asia/Kolkata")
    before = _all_days(db_session)
    saved = service.get_settings(db_session)

    def must_not_recompute(*args, **kwargs):
        raise AssertionError("recompute_all_days called for an unchanged zone")

    monkeypatch.setattr(rules, "recompute_all_days", must_not_recompute)
    spy = _Spy()
    monkeypatch.setattr(attendance_index, "invalidate", spy)

    for same in ("Asia/Kolkata", "  Asia/Kolkata "):
        result = service.set_timezone(db_session, same, updated_by="someone-else@corp.com")
        assert result["changed"] is False
        assert result["recomputed_days"] == 0
        assert result["timezone"] == "Asia/Kolkata"
    assert _all_days(db_session) == before
    assert spy.calls == 0
    assert service.get_settings(db_session)["updated_at"] == saved["updated_at"]


def test_set_default_zone_when_nothing_saved_is_a_no_op(db_session, monkeypatch):
    monkeypatch.setattr(rules, "recompute_all_days", lambda *a, **k: pytest.fail("recomputed"))
    result = service.set_timezone(db_session, "UTC", updated_by="x")
    assert result["changed"] is False and result["recomputed_days"] == 0
    assert result["timezone"] == "UTC"


def test_set_timezone_rejects_unknown_zone(db_session):
    with pytest.raises(ValueError, match="Unknown time zone 'Mars/Olympus'"):
        service.set_timezone(db_session, "Mars/Olympus", updated_by="x")
    assert service.get_timezone_name(db_session) == "UTC"


def test_set_timezone_is_atomic_when_recompute_fails(db_session, monkeypatch):
    _import(db_session, _MOVE_ROWS, tz="UTC")
    before = _all_days(db_session)
    real = rules.recompute_all_days

    def fails_after_rewriting(db, tz):
        real(db, tz)  # the day rows really are rewritten in the transaction...
        raise RuntimeError("simulated failure")  # ...and then it fails

    monkeypatch.setattr(rules, "recompute_all_days", fails_after_rewriting)
    spy = _Spy()
    monkeypatch.setattr(attendance_index, "invalidate", spy)

    with pytest.raises(RuntimeError, match="simulated failure"):
        service.set_timezone(db_session, "Asia/Kolkata", updated_by="x")

    assert service.get_timezone_name(db_session) == "UTC"
    assert db_session.get(AppSetting, service.TIMEZONE_KEY) is None
    assert _all_days(db_session) == before
    assert spy.calls == 0

    # The session is still usable and a real change then works.
    monkeypatch.setattr(rules, "recompute_all_days", real)
    result = service.set_timezone(db_session, "Asia/Kolkata", updated_by="x")
    assert result["changed"] is True
    assert _all_days(db_session) == _MOVE_IST
    assert spy.calls == 1


def test_set_timezone_invalidates_the_chat_index(db_session, monkeypatch):
    spy = _Spy()
    monkeypatch.setattr(attendance_index, "invalidate", spy)
    _set_org_zone(db_session, "Asia/Kolkata")
    assert spy.calls == 1


def test_recompute_all_days_returns_count_and_does_not_commit(db_session):
    _import(db_session, _MOVE_ROWS, tz="UTC")
    assert rules.recompute_all_days(db_session, IST) == 4
    assert _all_days(db_session) == _MOVE_IST
    db_session.rollback()  # the caller decides: nothing was committed
    assert _all_days(db_session) == _MOVE_UTC
    assert rules.recompute_all_days(db_session, LA) == 3
    assert _all_days(db_session) == _MOVE_LA


def test_recompute_days_deletes_a_day_with_no_punches_left(db_session):
    _import(db_session, [_row("22-09-2026 09:00", "RD1"), _row("23-09-2026 09:00", "RD1")], tz="UTC")
    assert set(_days(db_session, "RD1")) == {date(2026, 9, 22), date(2026, 9, 23)}

    db_session.execute(
        delete(BiometricPunchLog).where(
            BiometricPunchLog.emp_code == "RD1", BiometricPunchLog.log_date == utc(2026, 9, 22, 9)
        )
    )
    rules.recompute_days(db_session, {("RD1", date(2026, 9, 22)), ("RD1", date(2026, 9, 23))})
    assert _days(db_session, "RD1") == {date(2026, 9, 23): (utc(2026, 9, 23, 9), utc(2026, 9, 23, 9), 1)}


def test_recompute_days_uses_given_zone(db_session):
    _import(db_session, [_row("22-09-2026 20:00", "RD2")], tz="UTC")  # org UTC: day 22nd
    rules.recompute_days(db_session, {("RD2", date(2026, 9, 22)), ("RD2", date(2026, 9, 23))}, IST)
    # In IST the punch belongs to the 23rd; the 22nd has nothing left.
    assert _days(db_session, "RD2") == {date(2026, 9, 23): (utc(2026, 9, 22, 20), utc(2026, 9, 22, 20), 1)}


# --------------------------------------------------------------------------
# HTTP: /settings
# --------------------------------------------------------------------------


def test_settings_endpoints_require_login(client):
    assert client.get("/settings").status_code == 401
    assert client.put("/settings", json={"timezone": "Asia/Kolkata"}).status_code == 401
    assert client.get("/settings/timezones").status_code == 401
    resp = client.post(
        "/attendance/import",
        files={"file": ("p.csv", _csv([_row("22-09-2026 09:02")]), "text/csv")},
        data={"timezone": "Asia/Kolkata"},
    )
    assert resp.status_code == 401


def test_get_settings_defaults(client, monkeypatch):
    login_as(client, AVA)
    resp = client.get("/settings")
    assert resp.status_code == 200
    assert resp.json() == {
        "timezone": "UTC",
        "timezone_offset": "+00:00",
        "default_timezone": "UTC",
        "updated_at": None,
        "updated_by": None,
    }
    monkeypatch.setattr(settings, "default_timezone", "Asia/Kolkata")
    body = client.get("/settings").json()
    assert body["timezone"] == "Asia/Kolkata" and body["timezone_offset"] == "+05:30"
    assert body["default_timezone"] == "Asia/Kolkata"


def test_put_settings_changes_zone_and_recomputes(client, db_session):
    _import(db_session, _MOVE_ROWS, tz="UTC")
    login_as(client, AVA)

    resp = client.put("/settings", json={"timezone": "Asia/Kolkata"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["timezone"] == "Asia/Kolkata"
    assert body["timezone_offset"] == "+05:30"
    assert body["default_timezone"] == "UTC"
    assert body["changed"] is True
    assert body["recomputed_days"] == 4
    assert body["updated_by"] == AVA
    assert datetime.fromisoformat(body["updated_at"]).tzinfo is not None
    assert _all_days(db_session) == _MOVE_IST

    got = client.get("/settings").json()
    assert got == {k: body[k] for k in ("timezone", "timezone_offset", "default_timezone", "updated_at", "updated_by")}

    again = client.put("/settings", json={"timezone": "Asia/Kolkata"}).json()
    assert again["changed"] is False and again["recomputed_days"] == 0

    padded = client.put("/settings", json={"timezone": " America/Los_Angeles "}).json()
    assert padded["timezone"] == "America/Los_Angeles" and padded["changed"] is True
    assert padded["recomputed_days"] == 3
    assert _all_days(db_session) == _MOVE_LA


@pytest.mark.parametrize("payload", [{}, {"timezone": None}])
def test_put_settings_with_no_timezone_changes_nothing(client, db_session, payload):
    _set_org_zone(db_session, "Asia/Kolkata")
    login_as(client, AVA)
    resp = client.put("/settings", json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["timezone"] == "Asia/Kolkata"
    assert body["changed"] is False and body["recomputed_days"] == 0
    assert body["updated_by"] == "tester@corp.com"
    assert service.get_timezone_name(db_session) == "Asia/Kolkata"


@pytest.mark.parametrize("bad", ["Mars/Olympus", "posix/Asia/Kolkata", "", "../etc/passwd"])
def test_put_settings_rejects_unknown_zone_with_422(client, db_session, bad):
    _set_org_zone(db_session, "Asia/Kolkata")
    login_as(client, AVA)
    resp = client.put("/settings", json={"timezone": bad})
    assert resp.status_code == 422
    assert resp.json() == {"detail": f"Unknown time zone '{bad.strip()}'"}
    assert service.get_timezone_name(db_session) == "Asia/Kolkata"


def test_timezones_endpoint(client, monkeypatch):
    login_as(client, AVA)
    resp = client.get("/settings/timezones")
    assert resp.status_code == 200
    body = resp.json()
    assert body["default"] == "UTC"
    names = [z["name"] for z in body["timezones"]]
    assert len(names) >= 300 and len(set(names)) == len(names)
    assert {"name": "Asia/Kolkata", "offset": "+05:30", "label": "(UTC+05:30) Asia/Kolkata"} in body["timezones"]
    monkeypatch.setattr(settings, "default_timezone", "Europe/London")
    assert client.get("/settings/timezones").json()["default"] == "Europe/London"


# --------------------------------------------------------------------------
# HTTP: POST /attendance/import with a time zone; GET /attendance/{emp_code}
# --------------------------------------------------------------------------


def _upload(client, rows, tz: str | None = ..., filename: str = "p.csv"):
    kwargs: dict[str, Any] = {"files": {"file": (filename, _csv(rows), "text/csv")}}
    if tz is not ...:
        kwargs["data"] = {"timezone": tz}
    return client.post("/attendance/import", **kwargs)


def test_import_endpoint_takes_a_timezone_field(client, db_session):
    login_as(client, AVA)
    resp = _upload(client, [_row("22-09-2026 09:02", "HP1")], tz="Asia/Kolkata")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accepted"] == 1
    assert body["source_timezone"] == "Asia/Kolkata"
    assert body["timezone"] == "UTC"
    assert _punches(db_session, "HP1") == [utc(2026, 9, 22, 3, 32)]
    assert db_session.get(ImportBatch, uuid.UUID(body["batch_id"])).source_timezone == "Asia/Kolkata"


def test_import_endpoint_defaults_to_org_zone(client, db_session):
    login_as(client, AVA)
    assert client.put("/settings", json={"timezone": "America/New_York"}).status_code == 200

    omitted = _upload(client, [_row("23-09-2026 09:02", "HP2")])
    assert omitted.status_code == 200, omitted.text
    assert omitted.json()["source_timezone"] == "America/New_York"
    assert omitted.json()["timezone"] == "America/New_York"
    assert _punches(db_session, "HP2") == [utc(2026, 9, 23, 13, 2)]

    blank = _upload(client, [_row("23-09-2026 22:30", "HP3")], tz="")
    assert blank.status_code == 200, blank.text
    assert blank.json()["source_timezone"] == "America/New_York"
    # 22:30 EDT on the 23rd is 02:30Z on the 24th, still the 23rd in New York.
    assert _days(db_session, "HP3") == {date(2026, 9, 23): (utc(2026, 9, 24, 2, 30), utc(2026, 9, 24, 2, 30), 1)}

    # A file in IST while the org is in New York: dated in New York.
    ist = _upload(client, [_row("23-09-2026 09:02", "HP4")], tz="Asia/Kolkata")
    assert ist.json()["source_timezone"] == "Asia/Kolkata" and ist.json()["timezone"] == "America/New_York"
    assert _days(db_session, "HP4") == {date(2026, 9, 22): (utc(2026, 9, 23, 3, 32), utc(2026, 9, 23, 3, 32), 1)}


@pytest.mark.parametrize("bad", ["Mars/Olympus", "posix/Asia/Kolkata", "../etc/passwd"])
def test_import_endpoint_rejects_unknown_zone_with_400(client, db_session, bad):
    login_as(client, AVA)
    before = _counts(db_session)
    resp = _upload(client, [_row("22-09-2026 09:02", "HP5")], tz=bad)
    assert resp.status_code == 400
    assert resp.json() == {"detail": f"Unknown time zone '{bad}'"}
    assert _counts(db_session) == before


def test_employee_detail_returns_utc_instants(client, db_session):
    _set_org_zone(db_session, "Asia/Kolkata")
    day = service.org_today(db_session) - timedelta(days=2)
    _import(db_session, [_row(f"{day:%d-%m-%Y} 09:02", "UT1"), _row(f"{day:%d-%m-%Y} 18:45", "UT1")])
    login_as(client, AVA)

    detail = client.get("/attendance/UT1").json()
    [row] = detail["days"]
    assert row["work_date"] == day.isoformat()
    first = datetime.fromisoformat(row["first_punch"])
    last = datetime.fromisoformat(row["last_punch"])
    assert first.utcoffset() == timedelta(0) and last.utcoffset() == timedelta(0)
    assert first == datetime.combine(day, time(9, 2), tzinfo=IST)
    assert last == datetime.combine(day, time(18, 45), tzinfo=IST)


def test_employee_detail_window_uses_org_zone_today(client, db_session, monkeypatch):
    # 26 hours apart, so "today" in these zones is never the same date.
    monkeypatch.setattr(settings, "default_timezone", "Etc/GMT+12")
    west_today = service.org_today(db_session)
    edge = west_today - timedelta(days=60)
    db_session.add(AttendanceEmployee(emp_code="WIN1", name="Window Person"))
    db_session.flush()
    db_session.add(
        AttendanceDay(
            emp_code="WIN1",
            work_date=edge,
            first_punch=datetime.combine(edge, time(12), tzinfo=timezone.utc),
            last_punch=datetime.combine(edge, time(12), tzinfo=timezone.utc),
            punch_count=1,
        )
    )
    db_session.commit()
    login_as(client, AVA)

    assert client.get("/attendance/WIN1").json()["total_days_tracked"] == 1

    monkeypatch.setattr(settings, "default_timezone", "Pacific/Kiritimati")
    assert service.org_today(db_session) > west_today
    assert client.get("/attendance/WIN1").json()["total_days_tracked"] == 0


# --------------------------------------------------------------------------
# Chat: times, "today", prompt and index freshness in the org zone
# --------------------------------------------------------------------------

_CHAT_TODAY = date(2026, 9, 29)


@pytest.fixture
def ist_chat_data(db_session):
    """Org zone IST; file in IST (the org zone default)."""
    _set_org_zone(db_session, "Asia/Kolkata")
    _import(
        db_session,
        [
            _row("22-09-2026 09:02", "CH1", "Chitra Iyer", "Entry", "Eng"),  # 03:32Z
            _row("22-09-2026 18:45", "CH1", "Chitra Iyer", "Exit", "Eng"),  # 13:15Z
            _row("23-09-2026 09:10", "CH1", "Chitra Iyer", "Entry", "Eng"),  # 03:40Z, single punch
            _row("23-09-2026 01:30", "CH2", "Chirag Rao", "Entry", "Ops"),  # 20:00Z on the 22nd
            _row("23-09-2026 00:30", "CH2", "Chirag Rao", "Entry", "Ops"),  # 19:00Z on the 22nd
        ],
    )
    return db_session


def _tools(db, today: date | None = _CHAT_TODAY) -> dict:
    return {t.name: t for t in build_attendance_tools(db, today=today)}


def test_employee_attendance_prints_local_times(ist_chat_data):
    result = _tools(ist_chat_data)["employee_attendance"].invoke(
        {"employee": "CH1", "start_date": "2026-09-22", "end_date": "2026-09-23"}
    )
    days = {d["date"]: d for d in _row_dicts(result, "days", "day_columns")}
    assert days["2026-09-22"]["first_punch"] == "09:02"
    assert days["2026-09-22"]["last_punch"] == "18:45"
    assert days["2026-09-23"]["first_punch"] == "09:10"
    assert result["summary"]["median_first_punch"] == "09:02"
    assert result["summary"]["median_last_punch"] == "09:10"


def test_attendance_on_date_prints_local_times_on_local_days(ist_chat_data):
    tool = _tools(ist_chat_data)["attendance_on_date"]
    d22 = {p["emp_code"]: p for p in _row_dicts(tool.invoke({"date": "2026-09-22"}), "present", "present_columns")}
    assert set(d22) == {"CH1"}  # CH2's punches are UTC 22nd but IST 23rd
    assert (d22["CH1"]["first_punch"], d22["CH1"]["last_punch"]) == ("09:02", "18:45")

    d23 = {p["emp_code"]: p for p in _row_dicts(tool.invoke({"date": "2026-09-23"}), "present", "present_columns")}
    assert (d23["CH2"]["first_punch"], d23["CH2"]["last_punch"]) == ("00:30", "01:30")
    assert (d23["CH1"]["first_punch"], d23["CH1"]["last_punch"]) == ("09:10", "09:10")


def test_rank_employees_prints_local_times(ist_chat_data):
    result = _tools(ist_chat_data)["rank_employees"].invoke(
        {"metric": "earliest_first_punch", "start_date": "2026-09-22", "end_date": "2026-09-23"}
    )
    ranking = {r["emp_code"]: r for r in _row_dicts(result, "ranking", "ranking_columns")}
    assert ranking["CH2"]["value"] == "00:30"
    assert ranking["CH1"]["value"] == "09:02"
    assert ranking["CH2"]["rank"] == 1

    latest_last = _tools(ist_chat_data)["rank_employees"].invoke(
        {"metric": "latest_last_punch", "start_date": "2026-09-22", "end_date": "2026-09-23"}
    )
    top = _row_dicts(latest_last, "ranking", "ranking_columns")[0]
    assert (top["emp_code"], top["value"]) == ("CH1", "09:10")  # median_low of 09:10 and 18:45


def test_single_punch_days_prints_local_times(ist_chat_data):
    result = _tools(ist_chat_data)["single_punch_days"].invoke(
        {"start_date": "2026-09-22", "end_date": "2026-09-23"}
    )
    rows = _row_dicts(result, "days", "day_columns")
    assert [(r["date"], r["emp_code"], r["punch_time"]) for r in rows] == [("2026-09-23", "CH1", "09:10")]


def test_day_and_employee_documents_use_local_times(ist_chat_data):
    docs = {d.id: d for d in build_attendance_documents(ist_chat_data, today=_CHAT_TODAY, index_days=120)}
    d22 = docs["day:CH1:2026-09-22"].page_content
    assert "first punch 09:02" in d22 and "last punch 18:45" in d22
    d23 = docs["day:CH2:2026-09-23"].page_content
    assert "first punch 00:30" in d23 and "last punch 01:30" in d23
    assert "day:CH2:2026-09-22" not in docs
    employee = docs["employee:CH1"].page_content
    assert "median) first punch 09:02" in employee
    assert "03:32" not in " ".join(d.page_content for d in docs.values())


def _zone_whose_today_differs_from_the_machine() -> str:
    machine_today = date.today()
    return next(z for z in ("Pacific/Kiritimati", "Etc/GMT+12") if datetime.now(ZoneInfo(z)).date() != machine_today)


def test_attendance_on_date_today_is_org_zone_today(db_session, monkeypatch):
    zone = _zone_whose_today_differs_from_the_machine()
    monkeypatch.setattr(settings, "default_timezone", zone)
    org_day = service.org_today(db_session)
    assert org_day != date.today()
    _import(db_session, [_row(f"{org_day:%d-%m-%Y} 12:00", "TD1", "Tara Das")])

    result = _tools(db_session, today=None)["attendance_on_date"].invoke({"date": "today"})
    assert result["date"] == org_day.isoformat()
    [present] = _row_dicts(result, "present", "present_columns")
    assert (present["emp_code"], present["first_punch"]) == ("TD1", "12:00")


class _PromptCapturingModel(FakeMessagesListChatModel):
    seen: Any = None

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(list(messages))
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="ok"))])


def test_system_prompt_states_the_zone(db_session):
    viewer = db_session.get(OrgUser, AVA)
    prompt = system_prompt(viewer, _CHAT_TODAY, "Asia/Kolkata")
    assert "Asia/Kolkata (UTC+05:30)" in prompt
    assert "2026-09-29" in prompt


def test_answer_uses_org_zone_today_and_states_zone(db_session, monkeypatch):
    zone = _zone_whose_today_differs_from_the_machine()
    monkeypatch.setattr(settings, "default_timezone", zone)
    org_day = service.org_today(db_session)

    model = _PromptCapturingModel(responses=[], seen=[])
    assert answer(db_session, db_session.get(OrgUser, AVA), "hi", chat_model=model) == "ok"
    system = model.seen[0][0]
    assert isinstance(system, SystemMessage)
    assert f"{zone} (UTC{service.utc_offset_label(zone)})" in system.content
    assert org_day.isoformat() in system.content
    assert date.today().isoformat() not in system.content


def test_fingerprint_includes_the_org_zone(db_session, monkeypatch):
    _import(db_session, [_row("22-09-2026 09:02", "FP1")], tz="UTC")
    first = attendance_fingerprint(db_session)
    assert attendance_fingerprint(db_session) == first
    monkeypatch.setattr(settings, "default_timezone", "Europe/London")  # days unchanged, zone changed
    assert _all_days(db_session) != {} and attendance_fingerprint(db_session) != first


class _HashEmbeddings(Embeddings):
    DIM = 256

    def _vector(self, text_: str) -> list[float]:
        v = [0.0] * self.DIM
        for token in re.findall(r"[a-z0-9]+", text_.lower()):
            v[int(hashlib.md5(token.encode()).hexdigest(), 16) % self.DIM] += 1.0
        norm = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / norm for x in v]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._vector(t) for t in texts]

    def embed_query(self, text_: str) -> list[float]:
        return self._vector(text_)


def test_index_rebuilds_when_org_zone_changes(db_session, monkeypatch):
    base = _HashEmbeddings()
    monkeypatch.setattr(embeddings_module, "build_base_embeddings", lambda: base)
    monkeypatch.setattr(index_module, "build_base_embeddings", lambda: base)
    monkeypatch.setattr(settings, "embeddings_mode", "api")
    monkeypatch.setattr(settings, "hf_embedding_model", "test/timezone-hash-fake")
    monkeypatch.setattr(settings, "assistant_index_days", 120)

    day = service.org_today(db_session) - timedelta(days=3)
    _import(db_session, [_row(f"{day:%d-%m-%Y} 09:02", "IX1", "Indu Xavier")], tz="UTC")

    store = attendance_index.ensure_fresh(db_session)
    assert attendance_index.ensure_fresh(db_session) is store
    texts = [v["text"] for v in store.store.values()]
    assert any("first punch 09:02" in t for t in texts)

    # No invalidate() call and no data change: the zone alone must make it stale.
    monkeypatch.setattr(settings, "default_timezone", "Europe/London")
    rebuilt = attendance_index.ensure_fresh(db_session)
    assert rebuilt is not store
    texts = [v["text"] for v in rebuilt.store.values()]
    assert any("first punch 10:02" in t for t in texts)  # BST = UTC+1


# --------------------------------------------------------------------------
# Seed script: idempotent, zone-aware, leaves real imports alone
# --------------------------------------------------------------------------


@pytest.fixture(scope="module")
def seed_module():
    path = Path(__file__).resolve().parent.parent / "scripts" / "seed_demo_attendance.py"
    spec = importlib.util.spec_from_file_location("seed_demo_attendance_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_SEED_TODAY = date(2026, 9, 29)  # a Tuesday


def _seed_punch_count(db, seed_module) -> int:
    return db.scalar(
        select(func.count())
        .select_from(BiometricPunchLog)
        .join(ImportBatch, ImportBatch.id == BiometricPunchLog.import_batch_id)
        .where(ImportBatch.imported_by == seed_module.SEED_IMPORTED_BY)
    )


def test_seed_twice_leaves_one_copy_and_real_imports_untouched(db_session, seed_module):
    real = _import(
        db_session,
        [_row("22-09-2026 12:00", "EMP001", "Ava Martinez"), _row("22-09-2026 12:00", "REAL1", "Real Person")],
        tz="UTC",
    )
    real_batch = uuid.UUID(real.batch_id)
    real_ids = set(db_session.scalars(select(BiometricPunchLog.id).where(BiometricPunchLog.import_batch_id == real_batch)))
    expected_rows = len(seed_module.build_rows(_SEED_TODAY))
    assert expected_rows > 0

    first = seed_module.seed(db_session, today=_SEED_TODAY)
    second = seed_module.seed(db_session, today=_SEED_TODAY)

    assert first.import_result.accepted == second.import_result.accepted == expected_rows
    assert second.removed_batches == 1 and second.removed_punches == expected_rows
    seed_batches = db_session.scalars(
        select(ImportBatch).where(ImportBatch.imported_by == seed_module.SEED_IMPORTED_BY)
    ).all()
    assert len(seed_batches) == 1
    assert _seed_punch_count(db_session, seed_module) == expected_rows

    # The real batch and its punches are untouched.
    assert db_session.get(ImportBatch, real_batch) is not None
    assert set(db_session.scalars(select(BiometricPunchLog.id).where(BiometricPunchLog.import_batch_id == real_batch))) == real_ids
    assert _days(db_session, "REAL1") == {date(2026, 9, 22): (utc(2026, 9, 22, 12), utc(2026, 9, 22, 12), 1)}
    # The shared day has the demo punches plus the real one, once.
    assert _days(db_session, "EMP001")[date(2026, 9, 22)] == (utc(2026, 9, 22, 9, 5), utc(2026, 9, 22, 18, 10), 3)
    _assert_days_match_punches(db_session, timezone.utc)


def test_seed_with_a_new_window_removes_stale_demo_days(db_session, seed_module):
    seed_module.seed(db_session, today=_SEED_TODAY)
    later = _SEED_TODAY + timedelta(days=14)
    seed_module.seed(db_session, today=later)

    assert _seed_punch_count(db_session, seed_module) == len(seed_module.build_rows(later))
    for code in ("EMP001", "EMP002", "EMP003"):
        assert all(later - timedelta(days=14) <= d < later for d in _days(db_session, code)), code
    _assert_days_match_punches(db_session, timezone.utc)


def test_seed_reads_demo_times_in_the_org_zone(db_session, seed_module):
    _set_org_zone(db_session, "Asia/Kolkata")
    result = seed_module.seed(db_session, today=_SEED_TODAY)
    assert result.import_result.source_timezone == "Asia/Kolkata"
    batch = db_session.get(ImportBatch, uuid.UUID(result.import_result.batch_id))
    assert batch.source_timezone == "Asia/Kolkata"

    local_times = {p.astimezone(IST).strftime("%H:%M") for p in _punches(db_session, "EMP001")}
    assert local_times == {"09:05", "18:10"}
    assert _days(db_session, "EMP001")[date(2026, 9, 22)] == (utc(2026, 9, 22, 3, 35), utc(2026, 9, 22, 12, 40), 2)
    _assert_days_match_punches(db_session, IST)

    seed_module.seed(db_session, today=_SEED_TODAY)  # still idempotent in IST
    assert _seed_punch_count(db_session, seed_module) == len(seed_module.build_rows(_SEED_TODAY))
    _assert_days_match_punches(db_session, IST)


# --------------------------------------------------------------------------
# Meetings dashboard trend: weeks in the org zone
# --------------------------------------------------------------------------


def _required_meeting_at(db, start: datetime, key: str) -> None:
    series = MeetingSeries(external_id=f"tz-trend-{key}", title="Standup", organizer_email=AVA, recurrence="once")
    db.add(series)
    db.flush()
    occurrence = MeetingOccurrence(
        series_id=series.id, external_occurrence_id=key, start_time=start, end_time=start + timedelta(minutes=30)
    )
    db.add(occurrence)
    db.flush()
    db.add(Attendance(occurrence_id=occurrence.id, attendee_email=AVA, required=True, attended=True))
    db.flush()


def test_meeting_trend_weeks_follow_the_org_zone(db_session):
    # Sunday 27 Sep 20:30 UTC is Monday 28 Sep 02:00 in India: a different week.
    _required_meeting_at(db_session, utc(2026, 9, 27, 20, 30), "w1")

    def weeks() -> list[str]:
        return [w["week_start"] for w in analytics.attendance_trend(db_session, [AVA])]

    assert weeks() == ["2026-09-21"]
    _set_org_zone(db_session, "Asia/Kolkata")
    assert weeks() == ["2026-09-28"]
    # The database session's own zone plays no part.
    db_session.execute(text("SET LOCAL TIME ZONE 'America/Los_Angeles'"))
    assert weeks() == ["2026-09-28"]
    _set_org_zone(db_session, "UTC")
    assert weeks() == ["2026-09-21"]


# --------------------------------------------------------------------------
# Imports vs zone changes: one transaction, serialized by the zone lock
# --------------------------------------------------------------------------


def test_a_failed_import_rolls_back_every_punch(db_session, monkeypatch):
    _import(db_session, [_row("21-09-2026 09:00", "AT0")], tz="UTC")  # something already there
    before = _counts(db_session)
    real = importer_module.recompute_days

    def fails_after_recomputing(*args, **kwargs):
        real(*args, **kwargs)
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(importer_module, "recompute_days", fails_after_recomputing)
    with pytest.raises(RuntimeError, match="simulated failure"):
        import_punch_log(db_session, "t.csv", _csv([_row("22-09-2026 09:02", "AT1")]), imported_by="t", source_timezone="UTC")

    # Nothing of the failed import was kept: no batch, punch, employee or day.
    assert _counts(db_session) == before
    assert db_session.get(AttendanceEmployee, "AT1") is None

    # So retrying the upload gives exactly one copy.
    monkeypatch.setattr(importer_module, "recompute_days", real)
    _import(db_session, [_row("22-09-2026 09:02", "AT1")], tz="UTC")
    assert _punches(db_session, "AT1") == [utc(2026, 9, 22, 9, 2)]
    assert _days(db_session, "AT1") == {date(2026, 9, 22): (utc(2026, 9, 22, 9, 2), utc(2026, 9, 22, 9, 2), 1)}


@pytest.fixture
def other_connection(engine):
    """A second connection to the test database, standing in for another
    request running at the same time (its own transaction)."""
    conn = engine.connect()
    yield conn
    conn.rollback()
    conn.close()


def _in_thread(fn):
    box: dict[str, Any] = {}

    def target():
        try:
            box["result"] = fn()
        except BaseException as exc:  # re-raised in the test thread
            box["error"] = exc

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    return thread, box


def _outcome(thread: threading.Thread, box: dict):
    thread.join(30)
    assert not thread.is_alive(), "still blocked on the zone lock"
    if "error" in box:
        raise box["error"]
    return box["result"]


_BLOCKED_FOR = 0.5  # seconds a blocked call is given to (wrongly) get through


def test_import_waits_for_a_zone_change_and_uses_the_new_zone(db_session, other_connection):
    assert service.get_timezone_name(db_session) == "UTC"
    other = other_connection
    # Another request is changing the zone to IST: it holds the lock and has written the setting.
    other.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": service.ZONE_LOCK_KEY})
    other.execute(
        text("INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ('timezone', CAST(:v AS jsonb), now(), 'other')"),
        {"v": '"Asia/Kolkata"'},
    )
    thread, box = _in_thread(lambda: _import(db_session, [_row("22-09-2026 20:00", "LK1")], tz="UTC"))
    try:
        thread.join(_BLOCKED_FOR)
        assert thread.is_alive(), "the import didn't wait for the zone change"
        other.commit()  # the zone change commits; the import goes ahead

        result = _outcome(thread, box)
        assert result.timezone == "Asia/Kolkata"
        # 20:00 UTC on the 22nd is 01:30 on the 23rd in India: dated in the new zone.
        assert _days(db_session, "LK1") == {date(2026, 9, 23): (utc(2026, 9, 22, 20), utc(2026, 9, 22, 20), 1)}
    finally:
        other.rollback()
        thread.join(30)
        # The committed setting must not leak into other tests.
        other.execute(text("DELETE FROM app_settings WHERE key = 'timezone'"))
        other.commit()


@pytest.mark.parametrize("change", ["set_timezone", "reconcile"])
def test_zone_change_waits_for_an_import_in_flight(db_session, other_connection, monkeypatch, change):
    _import(db_session, _MOVE_ROWS, tz="UTC")
    other = other_connection
    # Another request is importing: it holds the lock shared until it commits.
    other.execute(text("SELECT pg_advisory_xact_lock_shared(:k)"), {"k": service.ZONE_LOCK_KEY})

    if change == "set_timezone":
        thread, box = _in_thread(lambda: _set_org_zone(db_session, "Asia/Kolkata")["recomputed_days"])
    else:  # DEFAULT_TIMEZONE changed with no zone saved; the startup check recomputes
        monkeypatch.setattr(settings, "default_timezone", "Asia/Kolkata")
        thread, box = _in_thread(lambda: service.reconcile_attendance_days(db_session))
    try:
        thread.join(_BLOCKED_FOR)
        assert thread.is_alive(), "the zone change didn't wait for the import"
        other.rollback()  # the import finishes

        assert _outcome(thread, box) == 4
        assert _all_days(db_session) == _MOVE_IST
    finally:
        other.rollback()
        thread.join(30)


def test_imports_do_not_block_each_other(db_session, other_connection):
    other_connection.execute(text("SELECT pg_advisory_xact_lock_shared(:k)"), {"k": service.ZONE_LOCK_KEY})
    thread, box = _in_thread(lambda: _import(db_session, [_row("22-09-2026 09:02", "PAR1")], tz="UTC"))
    try:
        thread.join(10)
        assert not thread.is_alive(), "an import waited for another import"
        assert _outcome(thread, box).accepted == 1
    finally:
        other_connection.rollback()
        thread.join(30)


def test_reconcile_recomputes_only_when_days_are_in_another_zone(db_session, monkeypatch):
    _import(db_session, _MOVE_ROWS, tz="UTC")
    assert service.reconcile_attendance_days(db_session) is None  # days were computed in UTC, the org zone
    monkeypatch.setattr(settings, "default_timezone", "Asia/Kolkata")
    assert service.reconcile_attendance_days(db_session) == 4
    assert _all_days(db_session) == _MOVE_IST
    assert service.reconcile_attendance_days(db_session) is None
