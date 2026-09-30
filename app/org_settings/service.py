"""Organization settings: read/write the app_settings key-value table.

The first (and so far only) setting is the organization time zone, an IANA
name such as "Asia/Kolkata". Punches are always stored as UTC instants; the
organization zone decides
- how every time is shown (the whole UI and the assistant's answers), and
- which calendar day a punch belongs to (AttendanceDay.work_date is the
  punch's date in this zone).

Until someone saves a zone on the Settings page, the zone is
settings.default_timezone (env DEFAULT_TIMEZONE, default "UTC"). Changing
the zone recomputes every AttendanceDay from the raw punches in the same
transaction and invalidates the assistant's search index.

Besides the "timezone" row, an internal "attendance_days_timezone" row
remembers which zone the AttendanceDay rows were last computed in, so a
change of DEFAULT_TIMEZONE with no zone saved is caught at startup
(reconcile_attendance_days) instead of leaving days on the old zone's dates.

Zone changes and imports are serialized with a Postgres advisory lock
(ZONE_LOCK_KEY): an import holds it shared from reading the org zone to its
commit, a zone change (or the startup reconcile) holds it exclusively from
reading the current zone to its commit. So a zone change never runs between
an import's zone read and its commit (the import's days would be dated in the
old zone), and an import never commits in the middle of a zone change's
full recompute (its new days would be missed, or deleted as stale).
"""
import functools
import logging
import zoneinfo
from datetime import date, datetime, timezone, tzinfo
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.config import settings
from app.org_settings.models import AppSetting

logger = logging.getLogger("app.org_settings")

TIMEZONE_KEY = "timezone"
# Internal: the zone AttendanceDay rows were last computed in. Not a user setting.
DAYS_TIMEZONE_KEY = "attendance_days_timezone"
# Before org time zones existed, days were grouped by the punch's UTC date.
LEGACY_DAYS_TIMEZONE = "UTC"
FALLBACK_TIMEZONE = "UTC"
SYSTEM_USER = "system"
# Transaction-level advisory lock key ("zone" in ASCII; any fixed bigint not
# used for another lock would do). See the module docstring.
ZONE_LOCK_KEY = 0x7A6F6E65

_EXCLUDED_NAMES = frozenset({"localtime", "Factory", "posixrules"})
_EXCLUDED_PREFIXES = ("posix/", "right/")
_warned_defaults: set[str] = set()


@functools.lru_cache(maxsize=1)
def allowed_timezones() -> frozenset[str]:
    """Every IANA zone name zoneinfo can load here (the tzdata package makes
    this the same on Windows, Linux and slim Docker images), minus the
    pseudo-zones that make no sense as an organization's zone."""
    return frozenset(
        name
        for name in zoneinfo.available_timezones()
        if name not in _EXCLUDED_NAMES and not name.startswith(_EXCLUDED_PREFIXES)
    )


def validate_timezone(name: str) -> str:
    """The zone name, stripped, if it is a known IANA zone; ValueError with a
    message meant for people otherwise."""
    if not isinstance(name, str):
        raise ValueError(f"Unknown time zone '{name}'")
    text = name.strip()
    if text not in allowed_timezones():
        raise ValueError(f"Unknown time zone '{text}'")
    return text


def default_timezone_name() -> str:
    """DEFAULT_TIMEZONE if it's a valid zone, else UTC (warned about once)."""
    name = settings.default_timezone
    try:
        return validate_timezone(name)
    except ValueError:
        if name not in _warned_defaults:
            _warned_defaults.add(name)
            logger.warning("DEFAULT_TIMEZONE %r is not a known IANA time zone; using %s", name, FALLBACK_TIMEZONE)
        return FALLBACK_TIMEZONE


def get_timezone_name(db: Session) -> str:
    """The organization's zone: the one saved in Settings, else the default."""
    row = db.get(AppSetting, TIMEZONE_KEY)
    if row is not None:
        try:
            return validate_timezone(row.value)
        except ValueError:
            logger.warning(
                "Saved organization time zone %r is not a known IANA time zone; using %s instead",
                row.value,
                default_timezone_name(),
            )
    return default_timezone_name()


def get_timezone(db: Session) -> ZoneInfo:
    return ZoneInfo(get_timezone_name(db))


def org_today(db: Session) -> date:
    """Today's date in the organization's zone."""
    return datetime.now(get_timezone(db)).date()


def as_utc(value: datetime) -> datetime:
    """An aware UTC datetime. Naive values are taken to be UTC already (that
    is how every punch is stored)."""
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def to_local(value: datetime, tz: tzinfo) -> datetime:
    """A stored (UTC) instant as wall-clock time in `tz`."""
    return as_utc(value).astimezone(tz)


def _offset_minutes(tz_name: str, at: datetime) -> int:
    offset = at.astimezone(ZoneInfo(tz_name)).utcoffset()
    return round(offset.total_seconds() / 60) if offset is not None else 0


def _format_offset(minutes: int) -> str:
    sign = "+" if minutes >= 0 else "-"
    hours, mins = divmod(abs(minutes), 60)
    return f"{sign}{hours:02d}:{mins:02d}"


def utc_offset_label(tz_name: str, at: datetime | None = None) -> str:
    """The zone's UTC offset at `at` (default: now) as "+05:30" / "-04:00"."""
    moment = as_utc(at) if at is not None else datetime.now(timezone.utc)
    return _format_offset(_offset_minutes(tz_name, moment))


def list_timezones() -> list[dict]:
    """Every allowed zone as {"name", "offset", "label"}, label like
    "(UTC+05:30) Asia/Kolkata", sorted by current offset, then name."""
    now = datetime.now(timezone.utc)
    rows = []
    for name in allowed_timezones():
        minutes = _offset_minutes(name, now)
        offset = _format_offset(minutes)
        rows.append((minutes, name, {"name": name, "offset": offset, "label": f"(UTC{offset}) {name}"}))
    rows.sort(key=lambda r: (r[0], r[1]))
    return [r[2] for r in rows]


def get_settings(db: Session) -> dict:
    name = get_timezone_name(db)
    row = db.get(AppSetting, TIMEZONE_KEY)
    return {
        "timezone": name,
        "timezone_offset": utc_offset_label(name),
        "default_timezone": default_timezone_name(),
        "updated_at": row.updated_at.isoformat() if row is not None and row.updated_at else None,
        "updated_by": row.updated_by if row is not None else None,
    }


def _upsert(db: Session, key: str, value, updated_by: str | None) -> None:
    """Insert or overwrite one setting (no commit). ON CONFLICT so two saves
    racing on a brand-new key don't fail on the primary key."""
    now = datetime.now(timezone.utc)
    stmt = pg_insert(AppSetting).values(key=key, value=value, updated_at=now, updated_by=updated_by)
    stmt = stmt.on_conflict_do_update(
        index_elements=[AppSetting.key],
        set_={"value": stmt.excluded.value, "updated_at": stmt.excluded.updated_at, "updated_by": stmt.excluded.updated_by},
    )
    db.execute(stmt)
    existing = db.identity_map.get(db.identity_key(AppSetting, key))
    if existing is not None:
        db.expire(existing)  # the next read sees the new value


def _expire_cached_settings(db: Session) -> None:
    """Forget AppSetting rows this session loaded before, so the next read
    after taking the zone lock sees what is committed now."""
    for obj in list(db.identity_map.values()):
        if isinstance(obj, AppSetting):
            db.expire(obj)


def lock_zone_shared(db: Session) -> None:
    """Take the zone lock shared until this transaction ends (imports: many
    can run at once, but not during a zone change). Call it before reading
    the org zone."""
    db.execute(text("SELECT pg_advisory_xact_lock_shared(:k)"), {"k": ZONE_LOCK_KEY})
    _expire_cached_settings(db)


def lock_zone_exclusive(db: Session) -> None:
    """Take the zone lock exclusively until this transaction ends (zone
    changes: waits for running imports, blocks new ones). Call it before
    reading the current zone."""
    db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": ZONE_LOCK_KEY})
    _expire_cached_settings(db)


def _invalidate_assistant_index() -> None:
    # Imported here: the chat package imports this module.
    from app.chat.attendance_index import attendance_index

    attendance_index.invalidate()


def set_timezone(db: Session, name: str, updated_by: str | None) -> dict:
    """Save the organization zone. When it actually changes, every
    AttendanceDay is recomputed in the new zone in the same transaction
    (all or nothing), and the assistant's search index is invalidated."""
    new = validate_timezone(name)
    from app.attendance.rules import recompute_all_days  # rules imports this module

    try:
        # Waits for imports in flight; the zone is read (fresh) under the lock.
        lock_zone_exclusive(db)
        current = get_timezone_name(db)
        if new == current:
            row = db.get(AppSetting, TIMEZONE_KEY)
            if row is not None and row.value != new:
                # The saved value was unusable (we were on the default); store the valid one.
                _upsert(db, TIMEZONE_KEY, new, updated_by)
            db.commit()  # ends the transaction, releasing the lock
            return {**get_settings(db), "changed": False, "recomputed_days": 0}

        _upsert(db, TIMEZONE_KEY, new, updated_by)
        recomputed = recompute_all_days(db, ZoneInfo(new))
        _upsert(db, DAYS_TIMEZONE_KEY, new, updated_by)
        db.commit()
    except Exception:
        db.rollback()
        raise
    logger.info("Organization time zone changed %s -> %s by %s; %d attendance days recomputed", current, new, updated_by, recomputed)
    _invalidate_assistant_index()
    return {**get_settings(db), "changed": True, "recomputed_days": recomputed}


def reconcile_attendance_days(db: Session) -> int | None:
    """Recompute every AttendanceDay if they were computed in another zone
    than the current organization zone — which happens when DEFAULT_TIMEZONE
    changes while no zone is saved in Settings (and, once, for data from
    before org time zones existed, which was grouped by UTC date). Returns
    the number of days after recomputing, or None when nothing was needed."""
    from app.attendance.rules import recompute_all_days

    try:
        # Same lock as a zone change: no import can commit mid-recompute.
        lock_zone_exclusive(db)
        current = get_timezone_name(db)
        marker = db.get(AppSetting, DAYS_TIMEZONE_KEY)
        computed_in = marker.value if marker is not None and isinstance(marker.value, str) else LEGACY_DAYS_TIMEZONE
        if computed_in == current:
            db.rollback()  # nothing to do; ends the transaction, releasing the lock
            return None

        recomputed = recompute_all_days(db, ZoneInfo(current))
        _upsert(db, DAYS_TIMEZONE_KEY, current, SYSTEM_USER)
        db.commit()
    except Exception:
        db.rollback()
        raise
    logger.info("Attendance days were computed in %s, organization zone is %s: recomputed %d days", computed_in, current, recomputed)
    _invalidate_assistant_index()
    return recomputed
