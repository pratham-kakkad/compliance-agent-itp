"""simplify attendance to plain presence tracking

Drops the fields the Attendance agent no longer parses or computes:
Direction/Category/Status/EmploymentType on the raw punch log and the
employee roster, and the worked-hours/status columns on the computed
daily rollup. AttendanceDay now just records first/last punch time and a
punch count per employee per day.

Revision ID: 2e6ae85dd4f4
Revises: cfa070b6d420
Create Date: 2026-09-27 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '2e6ae85dd4f4'
down_revision = 'cfa070b6d420'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column('biometric_punch_logs', 'direction')
    op.drop_column('biometric_punch_logs', 'category')
    op.drop_column('biometric_punch_logs', 'status')
    op.drop_column('biometric_punch_logs', 'employment_type')

    op.drop_column('attendance_employees', 'category')
    op.drop_column('attendance_employees', 'employment_type')

    op.alter_column('attendance_days', 'first_in', new_column_name='first_punch')
    op.alter_column('attendance_days', 'last_out', new_column_name='last_punch')
    op.add_column('attendance_days', sa.Column('punch_count', sa.Integer(), nullable=False, server_default='0'))
    op.alter_column('attendance_days', 'punch_count', server_default=None)
    op.drop_column('attendance_days', 'worked_minutes')
    op.drop_column('attendance_days', 'status')


def downgrade() -> None:
    op.add_column('attendance_days', sa.Column('status', sa.String(), nullable=False, server_default='present'))
    op.alter_column('attendance_days', 'status', server_default=None)
    op.add_column('attendance_days', sa.Column('worked_minutes', sa.Float(), nullable=True))
    op.drop_column('attendance_days', 'punch_count')
    op.alter_column('attendance_days', 'last_punch', new_column_name='last_out')
    op.alter_column('attendance_days', 'first_punch', new_column_name='first_in')

    op.add_column('attendance_employees', sa.Column('employment_type', sa.String(), nullable=True))
    op.add_column('attendance_employees', sa.Column('category', sa.String(), nullable=True))

    op.add_column('biometric_punch_logs', sa.Column('employment_type', sa.String(), nullable=True))
    op.add_column('biometric_punch_logs', sa.Column('status', sa.String(), nullable=False, server_default='Valid'))
    op.alter_column('biometric_punch_logs', 'status', server_default=None)
    op.add_column('biometric_punch_logs', sa.Column('category', sa.String(), nullable=True))
    op.add_column('biometric_punch_logs', sa.Column('direction', sa.String(), nullable=False, server_default=''))
    op.alter_column('biometric_punch_logs', 'direction', server_default=None)
