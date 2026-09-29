"""add attendance agent tables

Revision ID: cfa070b6d420
Revises: 833e7029121d
Create Date: 2026-09-25 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'cfa070b6d420'
down_revision = '833e7029121d'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'attendance_import_batches',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('filename', sa.String(), nullable=False),
        sa.Column('imported_by', sa.String(), nullable=False),
        sa.Column('imported_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('row_count', sa.Integer(), nullable=False),
        sa.Column('accepted_count', sa.Integer(), nullable=False),
        sa.Column('rejected_count', sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )

    op.create_table(
        'attendance_employees',
        sa.Column('emp_code', sa.String(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('company', sa.String(), nullable=True),
        sa.Column('department', sa.String(), nullable=True),
        sa.Column('category', sa.String(), nullable=True),
        sa.Column('employment_type', sa.String(), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('emp_code'),
    )

    op.create_table(
        'biometric_punch_logs',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('import_batch_id', sa.UUID(), nullable=True),
        sa.Column('log_date', sa.DateTime(timezone=True), nullable=False),
        sa.Column('device', sa.String(), nullable=True),
        sa.Column('direction', sa.String(), nullable=False),
        sa.Column('emp_code', sa.String(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('company', sa.String(), nullable=True),
        sa.Column('department', sa.String(), nullable=True),
        sa.Column('category', sa.String(), nullable=True),
        sa.Column('status', sa.String(), nullable=False),
        sa.Column('employment_type', sa.String(), nullable=True),
        sa.Column('imported_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['import_batch_id'], ['attendance_import_batches.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_biometric_punch_logs_emp_code', 'biometric_punch_logs', ['emp_code']
    )

    op.create_table(
        'attendance_days',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('emp_code', sa.String(), nullable=False),
        sa.Column('work_date', sa.Date(), nullable=False),
        sa.Column('first_in', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_out', sa.DateTime(timezone=True), nullable=True),
        sa.Column('worked_minutes', sa.Float(), nullable=True),
        sa.Column('status', sa.String(), nullable=False),
        sa.ForeignKeyConstraint(['emp_code'], ['attendance_employees.emp_code']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('emp_code', 'work_date'),
    )


def downgrade() -> None:
    op.drop_table('attendance_days')
    op.drop_index('ix_biometric_punch_logs_emp_code', table_name='biometric_punch_logs')
    op.drop_table('biometric_punch_logs')
    op.drop_table('attendance_employees')
    op.drop_table('attendance_import_batches')
