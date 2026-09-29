"""add assistant embedding cache

Cache of HuggingFace embedding vectors for the chat assistant's attendance
search index (app/chat/embeddings.py), keyed by embedding namespace + the
sha256 of the document text. Purely additive; safe to truncate.

Revision ID: 7f3b9c2a1e64
Revises: 2e6ae85dd4f4
Create Date: 2026-09-27 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = '7f3b9c2a1e64'
down_revision = '2e6ae85dd4f4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'assistant_embedding_cache',
        sa.Column('namespace', sa.String(), nullable=False),
        sa.Column('content_hash', sa.String(length=64), nullable=False),
        sa.Column('embedding', postgresql.ARRAY(sa.Float()), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('namespace', 'content_hash'),
    )


def downgrade() -> None:
    op.drop_table('assistant_embedding_cache')
