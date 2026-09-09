"""Add immutable export edit decisions; retain all M1/M2 data."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260909_m3_exports"
down_revision = "20260909_m2_ref_versions"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "export_versions",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("draft", postgresql.JSONB(), nullable=False),
        sa.UniqueConstraint("project_id", "revision"),
    )
    op.create_index("ix_export_versions_project_id", "export_versions", ["project_id"])

    op.create_table(
        "export_commands",
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id"), primary_key=True),
        sa.Column("key", sa.String(), primary_key=True),
        sa.Column("fingerprint", sa.String(), nullable=False),
        sa.Column("job_id", sa.UUID(), sa.ForeignKey("generation_jobs.id"), nullable=False),
    )


def downgrade():
    op.drop_table("export_commands")
    op.drop_table("export_versions")
