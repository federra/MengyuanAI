"""Immutable reference image sources and explicit specification confirmations."""

from alembic import op
import sqlalchemy as sa

revision = "20260909_m2_references"
down_revision = "20260909_m2_entities"
branch_labels = None
depends_on = None


def identity():
    return [
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def upgrade():
    op.create_table(
        "reference_images",
        *identity(),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "entity_version_id", sa.UUID(), sa.ForeignKey("entity_versions.id"), nullable=False
        ),
        sa.Column("file_id", sa.UUID(), sa.ForeignKey("media_files.id"), nullable=False),
        sa.UniqueConstraint("entity_version_id", "file_id"),
    )
    op.create_index("ix_reference_images_project_id", "reference_images", ["project_id"])
    op.create_table(
        "reference_confirmations",
        *identity(),
        sa.Column("image_id", sa.UUID(), sa.ForeignKey("reference_images.id"), nullable=False),
        sa.Column("specification_revision", sa.Integer(), nullable=False),
        sa.UniqueConstraint("image_id", "specification_revision"),
    )


def downgrade():
    op.drop_table("reference_confirmations")
    op.drop_table("reference_images")
