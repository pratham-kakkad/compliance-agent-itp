"""add app settings and import timezone

app_settings: organization-wide key-value settings (the Settings page),
starting with the organization time zone (app/org_settings/). Also records
on each attendance import batch which IANA zone the file's times were read
in. Existing punches are left as they are: they were stored as-is and are
taken to be UTC.

Revision ID: c41e8a9d2f6b
Revises: 7f3b9c2a1e64
Create Date: 2026-09-29 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'c41e8a9d2f6b'
down_revision = '7f3b9c2a1e64'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'app_settings',
        sa.Column('key', sa.String(), nullable=False),
        sa.Column('value', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_by', sa.String(), nullable=True),
        sa.PrimaryKeyConstraint('key'),
    )
    op.add_column('attendance_import_batches', sa.Column('source_timezone', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('attendance_import_batches', 'source_timezone')
    op.drop_table('app_settings')
