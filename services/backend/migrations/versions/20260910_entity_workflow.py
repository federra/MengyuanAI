"""Separate image inputs, explicit entity bindings and immutable library snapshots."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260910_entity_workflow"
down_revision = "20260910_board_import"
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
    op.add_column(
        "project_entities",
        sa.Column("archived", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    for field in ("input_file_id", "output_file_id"):
        op.add_column(
            "entity_versions", sa.Column(field, sa.UUID(), sa.ForeignKey("media_files.id"))
        )
    op.add_column("entity_versions", sa.Column("library_asset_id", sa.UUID()))
    op.add_column("entity_versions", sa.Column("library_version", sa.Integer()))
    op.add_column(
        "shot_reference_versions",
        sa.Column("entity_id", sa.UUID(), sa.ForeignKey("project_entities.id")),
    )
    op.alter_column("shot_reference_versions", "file_id", nullable=True)
    op.create_table(
        "entity_commands",
        *identity(),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("key", sa.String(128), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("response", postgresql.JSONB(), nullable=False),
        sa.UniqueConstraint("project_id", "key"),
    )
    op.create_index("ix_entity_commands_project_id", "entity_commands", ["project_id"])
    op.create_table(
        "library_assets",
        *identity(),
        sa.Column("owner_id", sa.UUID(), sa.ForeignKey("principals.id"), nullable=False),
        sa.Column("source_project_id", sa.UUID(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "source_entity_id", sa.UUID(), sa.ForeignKey("project_entities.id"), nullable=False
        ),
        sa.Column("source_entity_revision", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("voice", sa.String(200), nullable=False),
        sa.Column("three_view", sa.Boolean(), nullable=False),
        sa.Column("images", postgresql.JSONB(), nullable=False),
        sa.CheckConstraint("version = 1"),
    )
    op.create_index("ix_library_assets_owner_id", "library_assets", ["owner_id"])
    op.create_table(
        "library_adoptions",
        *identity(),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("asset_id", sa.UUID(), sa.ForeignKey("library_assets.id"), nullable=False),
        sa.Column("library_version", sa.Integer(), nullable=False),
        sa.Column("entity_id", sa.UUID(), sa.ForeignKey("project_entities.id"), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("response", postgresql.JSONB(), nullable=False),
        sa.UniqueConstraint("project_id", "idempotency_key"),
    )
    op.create_index("ix_library_adoptions_project_id", "library_adoptions", ["project_id"])


def downgrade():
    op.drop_table("library_adoptions")
    op.drop_table("library_assets")
    op.drop_table("entity_commands")
    # A populated pending-reference workflow cannot be represented by the old schema.
    # Fail rather than erase pending bindings or silently invent file IDs.
    op.alter_column("shot_reference_versions", "file_id", nullable=False)
    op.drop_column("shot_reference_versions", "entity_id")
    for field in ("library_version", "library_asset_id", "output_file_id", "input_file_id"):
        op.drop_column("entity_versions", field)
    op.drop_column("project_entities", "archived")
