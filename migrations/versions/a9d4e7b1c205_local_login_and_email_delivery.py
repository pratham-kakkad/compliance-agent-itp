"""local login (passwords, invites, resets) and e-mail delivery tracking

Additive only. org_users gets the columns for password sign-in, one-time
invite / reset tokens (only the SHA-256 is stored) and lockout bookkeeping;
notifications gets delivery bookkeeping for the SMTP sender.

Revision ID: a9d4e7b1c205
Revises: 17732890ccbe
Create Date: 2026-10-09 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a9d4e7b1c205'
down_revision = '17732890ccbe'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('org_users', sa.Column('password_hash', sa.String(), nullable=True))
    op.add_column('org_users', sa.Column('password_set_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('org_users', sa.Column('invite_token_hash', sa.String(), nullable=True))
    op.add_column('org_users', sa.Column('invite_expires_at', sa.DateTime(timezone=True), nullable=True))
    # "invite" or "reset": what the stored token is for.
    op.add_column('org_users', sa.Column('invite_purpose', sa.String(), nullable=True))
    op.add_column('org_users', sa.Column('invited_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('org_users', sa.Column('failed_logins', sa.Integer(), server_default=sa.text('0'), nullable=False))
    op.add_column('org_users', sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True))
    op.add_column('org_users', sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True))
    op.create_index('ix_org_users_invite_token_hash', 'org_users', ['invite_token_hash'], unique=False)

    op.add_column('notifications', sa.Column('email_sent_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('notifications', sa.Column('email_error', sa.Text(), nullable=True))
    op.add_column('notifications', sa.Column('email_attempts', sa.Integer(), server_default=sa.text('0'), nullable=False))


def downgrade() -> None:
    op.drop_column('notifications', 'email_attempts')
    op.drop_column('notifications', 'email_error')
    op.drop_column('notifications', 'email_sent_at')
    op.drop_index('ix_org_users_invite_token_hash', table_name='org_users')
    for col in ('last_login_at', 'locked_until', 'failed_logins', 'invited_at', 'invite_purpose',
                'invite_expires_at', 'invite_token_hash', 'password_set_at', 'password_hash'):
        op.drop_column('org_users', col)
