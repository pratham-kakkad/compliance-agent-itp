"""The Attendance agent: biometric device punch imports -> per-employee daily
attendance compliance. Self-contained (own tables, own connector, own API)
so it plugs into INT Comply the same way the Meetings agent does — see
app/attendance/models.py, importer.py, rules.py, api.py."""
