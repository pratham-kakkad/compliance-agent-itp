"""Biometric dashboard: presence and punctuality from the punch-log imports.

Everything is anchored on the latest working day that has data (not on today),
exactly like the existing Attendance insights: an old import must not make
everybody look absent. The payload says how old the data is.

Terms (also the tooltips):

- Working day       a day on which at least half the usual number of people punched
                    (app.attendance.analytics._working_dates), so Sundays with two people on call
                    are not a day everyone else was "absent".
- Expected          an employee is expected on a working day from the day they first appear in
                    the data until LEAVER_AFTER_DAYS days after their last punch. After that they
                    are assumed to have left: they stop counting as expected and are listed under
                    "not seen" instead of pulling every rate down for ever.
- Attendance rate   present employee-days / expected employee-days, on working days.
- Late arrival      first punch of a present day later than work_start + grace (organization zone).
- Early exit        last punch of a day with two or more punches earlier than work_end - grace.
- Missed-punch day  a present day with exactly one punch (no way to tell when they left).
- Hours worked      last punch - first punch, averaged over days with two or more punches.
"""
from bisect import bisect_left, bisect_right
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.attendance.analytics import _working_dates
from app.attendance.models import AttendanceDay, AttendanceEmployee, ImportBatch
from app.dashboards.common import (
    WEEKDAYS,
    bucket_count,
    bucket_from_end,
    bucket_start,
    kpi,
    mean,
    rate_tone,
    ratio,
    trend_is_daily,
)
from app.org_settings.service import as_utc, get_timezone, org_today
from app.org_settings.work_hours import get_work_hours, parse_hhmm

TARGET = 0.85
WARN_FLOOR = 0.70
LEAVER_AFTER_DAYS = 30
QUIET_DAYS = 7
STALE_AFTER_DAYS = 3
LIST_LIMIT = 8


@dataclass(frozen=True)
class DayRow:
    emp: str
    day: date
    first: datetime | None
    last: datetime | None
    punches: int


def _low_tone(value: float | None, good_max: float, warn_max: float) -> str:
    """For rates where lower is better."""
    if value is None:
        return "neutral"
    return "good" if value <= good_max else "warn" if value <= warn_max else "crit"


def _secs(dt: datetime, tz: ZoneInfo) -> float:
    local = as_utc(dt).astimezone(tz)
    return local.hour * 3600 + local.minute * 60 + local.second


@dataclass
class Stats:
    """Everything one period contributes, computed once per period."""

    dates: list[date]  # working days in the period
    expected: int = 0
    present: int = 0
    expected_by_day: dict = None
    present_by_day: dict = None
    by_dept: dict = None  # dept -> [expected, present]
    by_emp: dict = None  # emp -> [expected, present]
    present_rows: list = None
    late: int = 0
    first_punch_days: int = 0
    early: int = 0
    multi_days: int = 0
    single: int = 0
    spans: list = None
    late_by_emp: dict = None
    single_by_emp: dict = None


def _stats(
    dates: list[date],
    rows: list[DayRow],
    seen: dict[str, tuple[date, date]],
    dept_of: dict[str, str],
    tz: ZoneInfo,
    late_after: float,
    early_before: float,
) -> Stats:
    dates = sorted(dates)
    s = Stats(dates=dates, expected_by_day={}, present_by_day={}, by_dept={}, by_emp={}, present_rows=[], spans=[], late_by_emp={}, single_by_emp={})
    if not dates:
        return s
    dset = set(dates)
    # expected: employee x working day, from first_seen to last_seen + LEAVER_AFTER_DAYS
    for emp, (first, last) in seen.items():
        lo = bisect_left(dates, first)
        hi = bisect_right(dates, last + timedelta(days=LEAVER_AFTER_DAYS))
        if hi <= lo:
            continue
        n = hi - lo
        s.expected += n
        s.by_emp[emp] = [n, 0]
        d = s.by_dept.setdefault(dept_of.get(emp) or "Unassigned", [0, 0])
        d[0] += n
        for day in dates[lo:hi]:
            s.expected_by_day[day] = s.expected_by_day.get(day, 0) + 1
    for r in rows:
        if r.day not in dset:
            continue
        s.present += 1
        s.present_rows.append(r)
        s.present_by_day[r.day] = s.present_by_day.get(r.day, 0) + 1
        if r.emp in s.by_emp:
            s.by_emp[r.emp][1] += 1
        s.by_dept.setdefault(dept_of.get(r.emp) or "Unassigned", [0, 0])[1] += 1
        if r.first is not None:
            s.first_punch_days += 1
            if _secs(r.first, tz) > late_after:
                s.late += 1
                s.late_by_emp[r.emp] = s.late_by_emp.get(r.emp, 0) + 1
        if r.punches <= 1:
            s.single += 1
            s.single_by_emp[r.emp] = s.single_by_emp.get(r.emp, 0) + 1
        elif r.last is not None:
            s.multi_days += 1
            if _secs(r.last, tz) < early_before:
                s.early += 1
            span = (as_utc(r.last) - as_utc(r.first)).total_seconds() / 3600 if r.first else 0
            if span > 0:
                s.spans.append(span)
    return s


def _silent(seen_upto: dict[str, tuple[date, date]], at: date) -> tuple[list[tuple[str, date, int]], int]:
    """Employees with no punch in the QUIET_DAYS days up to `at`, split into those still expected
    (silent for less than LEAVER_AFTER_DAYS) and the count of those assumed gone.
    `seen_upto` maps employee -> (first day seen, last day seen on or before `at`)."""
    recent, gone = [], 0
    for emp, (first, last) in seen_upto.items():
        if first > at:
            continue
        silent = (at - last).days
        if silent < QUIET_DAYS:
            continue
        if silent > LEAVER_AFTER_DAYS:
            gone += 1
        else:
            recent.append((emp, last, silent))
    return recent, gone


def _trend(cur: Stats, prev: Stats, cur_range: tuple[date, date], prev_range: tuple[date, date], days: int) -> dict:
    daily = trend_is_daily(days)
    (first, last), (pfirst, plast) = cur_range, prev_range
    n = bucket_count(first, last, daily)

    def fold(st: Stats, lst: date):
        acc = [[0, 0] for _ in range(n)]
        for d, e in st.expected_by_day.items():
            i = bucket_from_end(d, lst, daily)
            if 0 <= i < n:
                acc[i][0] += e
                acc[i][1] += st.present_by_day.get(d, 0)
        return acc

    c, p = fold(cur, last), fold(prev, plast)
    pts = []
    for i in range(n - 1, -1, -1):
        e, pr = c[i]
        pe, ppr = p[i]
        pts.append(
            {
                "start": bucket_start(i, first, last, daily).isoformat(),
                "expected": e,
                "present": pr,
                "rate": ratio(pr, e),
                "previous_start": bucket_start(i, pfirst, plast, daily).isoformat(),
                "previous_rate": ratio(ppr, pe),
            }
        )
    return {"daily": daily, "points": pts, "target": TARGET}


def compute(
    *,
    days: int,
    employees: dict[str, tuple[str, str | None]],
    seen: dict[str, tuple[date, date]],
    seen_prev: dict[str, tuple[date, date]],
    daily_counts: dict[date, int],
    rows: list[DayRow],
    work: dict,
    tz: ZoneInfo,
    today: date,
    now: datetime,
    last_import: dict | None,
) -> dict:
    wh_start = parse_hhmm(work["work_start"])
    wh_end = parse_hhmm(work["work_end"])
    grace = int(work["grace_minutes"])
    late_after = wh_start.hour * 3600 + wh_start.minute * 60 + grace * 60
    early_before = wh_end.hour * 3600 + wh_end.minute * 60 - grace * 60
    scheduled_hours = ((wh_end.hour * 60 + wh_end.minute) - (wh_start.hour * 60 + wh_start.minute)) / 60

    base = {
        "area": "biometric",
        "as_of": now.isoformat(),
        "timezone": str(tz),
        "work_hours": work,
        "thresholds": {"target": TARGET, "quiet_days": QUIET_DAYS, "leaver_after_days": LEAVER_AFTER_DAYS},
        "last_import": last_import,
    }
    working = _working_dates(daily_counts)
    if not working:
        quiet = "No punch-log data has been imported yet"
        keys = [
            ("attendance", "Attendance rate", "percent"),
            ("present_today", "Present on the latest day", "count"),
            ("late_arrivals", "Late arrivals", "percent"),
            ("early_exits", "Early exits", "percent"),
            ("avg_hours", "Hours on site", "hours"),
            ("missed_punch", "Missed-punch days", "percent"),
            ("not_seen", "Not seen in 7 days", "count"),
        ]
        return {
            **base,
            "empty": True,
            "data_through": None,
            "data_age_days": None,
            "stale": False,
            "period": None,
            "kpis": {k: kpi(k, label, "", unit, None, no_data=quiet) for k, label, unit in keys},
            "trend": {"daily": trend_is_daily(days), "points": [], "target": TARGET},
            "weekday": [{"day": d, "expected": 0, "present": 0, "rate": None} for d in WEEKDAYS],
            "departments": [],
            "not_seen": [],
            "not_seen_total": 0,
            "missed_punch_people": [],
            "late_people": [],
            "low_presence_people": [],
        }

    ref = max(working)
    latest_data = max(daily_counts)
    cur_range = (ref - timedelta(days=days - 1), ref)
    prev_range = (ref - timedelta(days=2 * days - 1), ref - timedelta(days=days))
    cur_dates = [d for d in working if cur_range[0] <= d <= cur_range[1]]
    prev_dates = [d for d in working if prev_range[0] <= d <= prev_range[1]]
    dept_of = {e: d for e, (_n, d) in employees.items()}
    cur_rows = [r for r in rows if cur_range[0] <= r.day <= cur_range[1]]
    prev_rows = [r for r in rows if prev_range[0] <= r.day <= prev_range[1]]
    cur = _stats(cur_dates, cur_rows, seen, dept_of, tz, late_after, early_before)
    prev = _stats(prev_dates, prev_rows, seen_prev, dept_of, tz, late_after, early_before)

    age = (today - latest_data).days
    qd = f"No working days with data in the last {days} days"
    rate, prate = ratio(cur.present, cur.expected), ratio(prev.present, prev.expected)

    # --- present on the reference day, against the working day before it
    prior_days = sorted(d for d in working if d < ref)
    prior = prior_days[-1] if prior_days else None
    exp_ref = cur.expected_by_day.get(ref, 0)
    pres_ref = cur.present_by_day.get(ref, 0)
    prior_stats = None
    if prior is not None:
        prior_stats = _stats([prior], [r for r in rows if r.day == prior], seen_prev if prior <= prev_range[1] else seen, dept_of, tz, late_after, early_before)
    prior_present = prior_stats.present if prior_stats and prior_stats.expected else None

    late_rate = ratio(cur.late, cur.first_punch_days)
    plate_rate = ratio(prev.late, prev.first_punch_days)
    early_rate = ratio(cur.early, cur.multi_days)
    pearly_rate = ratio(prev.early, prev.multi_days)
    single_rate = ratio(cur.single, cur.present)
    psingle_rate = ratio(prev.single, prev.present)
    avg_h = mean(cur.spans)
    pavg_h = mean(prev.spans)

    recent, gone = _silent(seen, ref)
    precent, _pgone = _silent(seen_prev, prev_range[1]) if prev_dates else ([], 0)
    wh_text = f"{work['work_start']} to {work['work_end']}"

    kpis = {
        "attendance": kpi(
            "attendance",
            "Attendance rate",
            f"Present employee-days divided by expected employee-days on working days. People with no punch for {LEAVER_AFTER_DAYS}+ days are assumed to have left and stop counting as expected.",
            "percent",
            rate,
            previous=prate,
            good="up",
            target=TARGET,
            tone=rate_tone(rate, TARGET, WARN_FLOOR),
            numerator=cur.present,
            denominator=cur.expected,
            detail=f"{cur.present:,} of {cur.expected:,} expected days · {len(cur.dates)} working days",
            no_data=qd,
        ),
        "present_today": kpi(
            "present_today",
            f"Present on {ref.strftime('%b')} {ref.day}",
            "Employees who punched on the latest working day, out of the employees expected that day.",
            "count",
            pres_ref if exp_ref else None,
            previous=prior_present,
            good="up",
            tone=rate_tone(ratio(pres_ref, exp_ref), TARGET, WARN_FLOOR),
            numerator=pres_ref,
            denominator=exp_ref,
            detail=f"of {exp_ref} expected",
            no_data="Nobody was expected on the latest working day",
            compare_label="vs previous working day",
        ),
        "late_arrivals": kpi(
            "late_arrivals",
            "Late arrivals",
            f"Present days whose first punch is later than {work['work_start']} plus {grace} minutes of grace, as a share of present days. Work hours ({wh_text}) are set on this dashboard.",
            "percent",
            late_rate,
            previous=plate_rate,
            good="down",
            tone=_low_tone(late_rate, 0.10, 0.25),
            numerator=cur.late,
            denominator=cur.first_punch_days,
            detail=f"{cur.late:,} of {cur.first_punch_days:,} present days",
            no_data=qd,
        ),
        "early_exits": kpi(
            "early_exits",
            "Early exits",
            f"Days with two or more punches whose last punch is earlier than {work['work_end']} minus {grace} minutes of grace, as a share of those days.",
            "percent",
            early_rate,
            previous=pearly_rate,
            good="down",
            tone=_low_tone(early_rate, 0.10, 0.25),
            numerator=cur.early,
            denominator=cur.multi_days,
            detail=f"{cur.early:,} of {cur.multi_days:,} days with an exit punch",
            no_data="No day had both an arrival and a later punch",
        ),
        "avg_hours": kpi(
            "avg_hours",
            "Hours on site",
            "Average time between the first and the last punch of a day, over days with two or more punches. Reflects real hours only if people punch out.",
            "hours",
            avg_h,
            previous=pavg_h,
            target=round(scheduled_hours, 2),
            tone="neutral",
            detail=f"scheduled {scheduled_hours:g} h · {len(cur.spans):,} days measured",
            no_data="No day had two or more punches",
        ),
        "missed_punch": kpi(
            "missed_punch",
            "Missed-punch days",
            "Present days with exactly one punch, so arrival or departure is unknown, as a share of present days.",
            "percent",
            single_rate,
            previous=psingle_rate,
            good="down",
            tone=_low_tone(single_rate, 0.05, 0.15),
            numerator=cur.single,
            denominator=cur.present,
            detail=f"{cur.single:,} of {cur.present:,} present days",
            no_data=qd,
        ),
        "not_seen": kpi(
            "not_seen",
            f"Not seen in {QUIET_DAYS} days",
            f"Employees still expected (last punch less than {LEAVER_AFTER_DAYS} days ago) with no punch in the {QUIET_DAYS} days up to the latest working day.",
            "count",
            len(recent),
            previous=len(precent) if prev_dates else None,
            good="down",
            tone="good" if not recent else "warn" if len(recent) < max(3, 0.05 * len(seen)) else "crit",
            denominator=len(seen),
            detail=(f"+{gone} silent {LEAVER_AFTER_DAYS}+ days (assumed left)" if gone else f"of {len(seen)} employees"),
        ),
    }

    # --- weekday pattern
    wd_e, wd_p = defaultdict(int), defaultdict(int)
    for d, e in cur.expected_by_day.items():
        wd_e[d.weekday()] += e
        wd_p[d.weekday()] += cur.present_by_day.get(d, 0)
    weekday = [{"day": n, "expected": wd_e[i], "present": wd_p[i], "rate": ratio(wd_p[i], wd_e[i])} for i, n in enumerate(WEEKDAYS)]

    # --- departments, lowest first, with the previous period for the delta
    departments = []
    for dept, (e, p) in cur.by_dept.items():
        pe, pp = prev.by_dept.get(dept, (0, 0))
        r, pr = ratio(p, e), ratio(pp, pe)
        departments.append(
            {
                "department": dept,
                "headcount": sum(1 for emp, (ee, _pp) in cur.by_emp.items() if (dept_of.get(emp) or "Unassigned") == dept and ee),
                "expected": e,
                "present": p,
                "rate": r,
                "previous_rate": pr,
                "delta": round(r - pr, 4) if r is not None and pr is not None else None,
            }
        )
    departments.sort(key=lambda d: (d["rate"] is None, d["rate"] if d["rate"] is not None else 0, d["department"]))

    def person(emp: str, **extra) -> dict:
        return {"emp_code": emp, "name": employees.get(emp, (emp, None))[0], "department": employees.get(emp, (emp, None))[1], **extra}

    not_seen = sorted(recent, key=lambda t: -t[2])
    not_seen_rows = [person(e, last_seen=l.isoformat(), days_silent=n, assumed_left=False) for e, l, n in not_seen]
    if len(not_seen_rows) < LIST_LIMIT:
        long_gone = sorted(
            ((e, l, (ref - l).days) for e, (f, l) in seen.items() if (ref - l).days > LEAVER_AFTER_DAYS and f <= ref),
            key=lambda t: t[2],
        )
        not_seen_rows += [person(e, last_seen=l.isoformat(), days_silent=n, assumed_left=True) for e, l, n in long_gone]

    missed_people = sorted(cur.single_by_emp.items(), key=lambda kv: (-kv[1], employees.get(kv[0], (kv[0],))[0]))
    present_by_emp = {emp: v[1] for emp, v in cur.by_emp.items()}
    missed_rows = [
        person(e, count=n, days_present=present_by_emp.get(e, n), rate=ratio(n, present_by_emp.get(e, n)))
        for e, n in missed_people[:LIST_LIMIT]
    ]
    late_people = sorted(cur.late_by_emp.items(), key=lambda kv: (-kv[1], employees.get(kv[0], (kv[0],))[0]))
    late_rows = [
        person(e, count=n, days_present=present_by_emp.get(e, n), rate=ratio(n, present_by_emp.get(e, n)))
        for e, n in late_people[:LIST_LIMIT]
    ]
    low_presence = sorted(
        ((e, v) for e, v in cur.by_emp.items() if v[0] >= 3 and v[1] < v[0]),
        key=lambda kv: (kv[1][1] / kv[1][0], -kv[1][0], employees.get(kv[0], (kv[0],))[0]),
    )
    low_rows = [person(e, expected=v[0], present=v[1], rate=ratio(v[1], v[0])) for e, v in low_presence[:LIST_LIMIT]]

    return {
        **base,
        "empty": False,
        "data_through": latest_data.isoformat(),
        "reference_day": ref.isoformat(),
        "data_age_days": age,
        "stale": age > STALE_AFTER_DAYS,
        "period": {
            "days": days,
            "start": cur_range[0].isoformat(),
            "end": cur_range[1].isoformat(),
            "previous_start": prev_range[0].isoformat(),
            "previous_end": prev_range[1].isoformat(),
            "working_days": len(cur.dates),
            "previous_working_days": len(prev.dates),
        },
        "headcount": len(seen),
        "kpis": kpis,
        "trend": _trend(cur, prev, cur_range, prev_range, days),
        "weekday": weekday,
        "departments": departments,
        "not_seen": not_seen_rows[:LIST_LIMIT],
        "not_seen_total": len(recent) + gone,
        "missed_punch_people": missed_rows,
        "late_people": late_rows,
        "low_presence_people": low_rows,
    }


def build(db: Session, days: int, now: datetime) -> dict:
    tz = get_timezone(db)
    today = org_today(db)
    employees = {e: (n, d) for e, n, d in db.execute(select(AttendanceEmployee.emp_code, AttendanceEmployee.name, AttendanceEmployee.department)).all()}
    daily = {d: n for d, n in db.execute(select(AttendanceDay.work_date, func.count()).group_by(AttendanceDay.work_date)).all()}
    seen = {
        e: (f, l)
        for e, f, l in db.execute(
            select(AttendanceDay.emp_code, func.min(AttendanceDay.work_date), func.max(AttendanceDay.work_date)).group_by(AttendanceDay.emp_code)
        ).all()
    }
    last_import = None
    li = db.execute(select(ImportBatch.imported_at, ImportBatch.filename).order_by(ImportBatch.imported_at.desc()).limit(1)).first()
    if li:
        last_import = {"at": li.imported_at.isoformat(), "file": li.filename}

    working = _working_dates(daily)
    rows: list[DayRow] = []
    seen_prev: dict = {}
    if working:
        ref = max(working)
        lo = ref - timedelta(days=2 * days - 1)
        prev_end = ref - timedelta(days=days)
        rows = [
            DayRow(e, d, fp, lp, pc)
            for e, d, fp, lp, pc in db.execute(
                select(AttendanceDay.emp_code, AttendanceDay.work_date, AttendanceDay.first_punch, AttendanceDay.last_punch, AttendanceDay.punch_count).where(
                    AttendanceDay.work_date >= lo, AttendanceDay.work_date <= ref
                )
            ).all()
        ]
        # as of the end of the previous period: first day seen and last day seen on or before it
        seen_prev = {
            e: (f, l)
            for e, f, l in db.execute(
                select(AttendanceDay.emp_code, func.min(AttendanceDay.work_date), func.max(AttendanceDay.work_date))
                .where(AttendanceDay.work_date <= prev_end)
                .group_by(AttendanceDay.emp_code)
            ).all()
        }
    return compute(
        days=days,
        employees=employees,
        seen=seen,
        seen_prev=seen_prev,
        daily_counts=daily,
        rows=rows,
        work=get_work_hours(db),
        tz=tz,
        today=today,
        now=now,
        last_import=last_import,
    )
