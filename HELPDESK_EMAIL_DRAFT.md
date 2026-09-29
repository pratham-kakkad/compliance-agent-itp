# Helpdesk / IT request — Azure AD app registration for Meeting Compliance

Send something like this to whoever administers your Microsoft 365 / Azure AD tenant.

---

**Subject:** Azure AD app registration request — Meeting Compliance dashboard

Hi team,

I'm rolling out an internal Meeting Compliance dashboard that needs two things from Azure AD / Microsoft Graph. Could you help set up an app registration?

**1. App registration for "Sign in with Microsoft" (needed now)**

- Register a new app (e.g. "Meeting Compliance") in Azure AD.
- Redirect URI (Web platform): `http://localhost:8010/auth/callback` for local development — I'll send the production URL once we deploy.
- Delegated Microsoft Graph permission: `User.Read` (basic sign-in only — no extra data access needed for login itself).
- Please send back: **Application (client) ID**, a **client secret** (or let me know if you'd rather issue a certificate), and the **Directory (tenant) ID**.

**2. Application permissions for meeting attendance sync (needed for real Teams attendance)**

The app already syncs real Teams meeting attendance in the background (`GraphTeamsProvider`) for everyone who signs in with Microsoft — it just needs these **application** (not delegated) Microsoft Graph permissions, admin-consented, before that sync can return anything:
- `OnlineMeetings.Read.All`
- `OnlineMeetingArtifact.Read.All`
- `Calendars.Read`
- `User.Read.All`

Happy to hop on a call if it's easier to walk through the Azure portal together.

Thanks!

---

### What this unlocks once credentials arrive

Set these in `.env`:

```
MS_CLIENT_ID=<Application (client) ID>
MS_CLIENT_SECRET=<client secret>
MS_TENANT_ID=<Directory (tenant) ID>
MS_REDIRECT_URI=http://localhost:8010/auth/callback
```

As soon as those are set, "Sign in with Microsoft" appears on the login screen. Anyone who signs in that way automatically gets their own account created and their real calendar synced — no manual directory setup needed. A separate "try it with a demo account" option stays available alongside it and always shows the same 3 fixed demo accounts with sample data, so the product is fully explorable either way, before or after these credentials arrive.
