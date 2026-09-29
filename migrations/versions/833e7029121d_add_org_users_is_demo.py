"""add org_users.is_demo

Revision ID: 833e7029121d
Revises: 563ea24f3fbe
Create Date: 2026-09-23 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '833e7029121d'
down_revision = '563ea24f3fbe'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'org_users',
        sa.Column('is_demo', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.alter_column('org_users', 'is_demo', server_default=None)


def downgrade() -> None:
    op.drop_column('org_users', 'is_demo')
