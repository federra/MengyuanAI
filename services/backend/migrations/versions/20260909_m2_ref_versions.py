"""Replace image content while preserving legacy stable reference UUIDs."""

from alembic import op
import sqlalchemy as sa

revision = "20260909_m2_ref_versions"
down_revision = "20260909_m2_media"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "shot_reference_versions",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("shot_id", sa.UUID(), sa.ForeignKey("content_identities.id"), nullable=False),
        sa.Column("ref_id", sa.UUID(), sa.ForeignKey("media_files.id"), nullable=False),
        sa.Column("file_id", sa.UUID(), sa.ForeignKey("media_files.id"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.UniqueConstraint("shot_id", "ref_id", "revision"),
    )
    op.create_index(
        "ix_shot_reference_versions_project_id", "shot_reference_versions", ["project_id"]
    )


def downgrade():
    op.drop_table("shot_reference_versions")
