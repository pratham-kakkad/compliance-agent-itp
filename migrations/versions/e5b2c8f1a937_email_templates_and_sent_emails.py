"""e-mail templates and the log of manual compliance e-mails

Additive only: two new tables, nothing existing is altered. The five built-in
templates are seeded by the application at start-up (app/compliance/messaging.py),
not here, so editing them never fights a migration.

Revision ID: e5b2c8f1a937
Revises: a9d4e7b1c205
Create Date: 2026-10-09 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'e5b2c8f1a937'
down_revision = 'a9d4e7b1c205'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'email_templates',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('key', sa.String(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('kind', sa.String(), nullable=False),
        sa.Column('subject', sa.String(), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('is_system', sa.Boolean(), nullable=False),
        sa.Column('active', sa.Boolean(), nullable=False),
        sa.Column('created_by', sa.String(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('key'),
    )
    op.create_table(
        'sent_emails',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('batch_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('sent_by', sa.String(), nullable=False),
        sa.Column('recipient_email', sa.String(), nullable=False),
        sa.Column('recipient_name', sa.String(), nullable=False),
        sa.Column('template_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('template_name', sa.String(), nullable=False),
        sa.Column('subject', sa.String(), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('obligation_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('compliance_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('context', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('status', sa.String(), nullable=False),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['template_id'], ['email_templates.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['obligation_id'], ['obligations.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['compliance_id'], ['compliances.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_sent_emails_batch', 'sent_emails', ['batch_id'], unique=False)
    op.create_index('ix_sent_emails_recipient', 'sent_emails', ['recipient_email', 'created_at'], unique=False)
    op.create_index('ix_sent_emails_sender', 'sent_emails', ['sent_by', 'created_at'], unique=False)
    op.create_index('ix_sent_emails_obligation', 'sent_emails', ['obligation_id'], unique=False)
    op.create_index('ix_sent_emails_compliance', 'sent_emails', ['compliance_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_sent_emails_compliance', table_name='sent_emails')
    op.drop_index('ix_sent_emails_obligation', table_name='sent_emails')
    op.drop_index('ix_sent_emails_sender', table_name='sent_emails')
    op.drop_index('ix_sent_emails_recipient', table_name='sent_emails')
    op.drop_index('ix_sent_emails_batch', table_name='sent_emails')
    op.drop_table('sent_emails')
    op.drop_table('email_templates')
