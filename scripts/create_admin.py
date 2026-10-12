"""Create (or update) a Super Admin who can sign in with an e-mail and password.

This is the bootstrap for a fresh install with no demo data and no Microsoft
sign-in: after `python -m alembic upgrade head`, run

    python scripts/create_admin.py you@company.com "Your Name"

It prints a one-time link to set the password (open it in a browser; it is
valid for 7 days, single use). Use --password to set the password directly
instead (min 10 characters), e.g. for automation:

    python scripts/create_admin.py you@company.com "Your Name" --password "a long passphrase"

Safe to re-run: an existing person keeps their data, gets the Super Admin
role, is re-activated, and receives a new link (or the new --password).

The link is built from PUBLIC_BASE_URL (default http://localhost:8010).
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select

from app.auth import local, passwords
from app.compliance import audit
from app.compliance.models import Role, UserRole
from app.compliance.seed import seed_system_data
from app.database import SessionLocal
from app.models import OrgUser


def main() -> int:
    parser = argparse.ArgumentParser(description="Create or update a Super Admin with a local password.")
    parser.add_argument("email", help="the person's e-mail address (also their sign-in name)")
    parser.add_argument("name", help="their full name")
    parser.add_argument("--title", default=None, help="job title (optional)")
    parser.add_argument("--password", default=None, help="set this password directly instead of printing a link")
    args = parser.parse_args()

    email = local.normalize_email(args.email)
    if "@" not in email or " " in email:
        print("That doesn't look like an e-mail address.", file=sys.stderr)
        return 2
    if not args.name.strip():
        print("A name is required.", file=sys.stderr)
        return 2
    if args.password is not None:
        try:
            passwords.validate_password(args.password, email=email)
        except passwords.PasswordPolicyError as exc:
            print(f"Password rejected: {exc}", file=sys.stderr)
            return 2

    db = SessionLocal()
    try:
        seed_system_data(db)  # the built-in roles, in case the app has never started
        user = local.find_user(db, email)
        created = user is None
        if created:
            user = OrgUser(email=email, name=args.name.strip(), title=(args.title or "").strip(), is_demo=False, is_active=True)
            db.add(user)
            db.flush()
        else:
            user.name = args.name.strip()
            if args.title is not None:
                user.title = args.title.strip()
            user.is_active = True

        role = db.scalar(select(Role).where(Role.key == "super_admin"))
        if role is None:
            print("The super_admin role is missing; run the migrations first.", file=sys.stderr)
            return 1
        has_role = db.scalar(select(UserRole).where(UserRole.user_email == user.email, UserRole.role_id == role.id))
        if has_role is None:
            db.add(UserRole(user_email=user.email, role_id=role.id))

        link = None
        if args.password is not None:
            local.set_password(user, passwords.hash_password(args.password))
        else:
            purpose = local.PURPOSE_INVITE if user.password_hash is None else local.PURPOSE_RESET
            token = local.issue_token(user, purpose)
            link = local.invite_url(token) if purpose == local.PURPOSE_INVITE else local.reset_url(token)

        audit.record(
            db, "system", "user.created" if created else "user.updated", "user", user.email,
            after={"name": user.name, "roles": ["super_admin"]}, meta={"via": "scripts/create_admin.py"},
        )
        db.commit()
    finally:
        db.close()

    print(("Created" if created else "Updated") + f" {email} as a Super Admin.")
    if link:
        print("\nOpen this link to set the password (single use):\n\n  " + link + "\n")
    else:
        print("Password set. Sign in at " + local.base_url() + "/ui/ with your e-mail and that password.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
