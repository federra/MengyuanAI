"""Durable import previews, idempotent results and pending image descriptions."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260910_board_import"
down_revision = "20260909_m3_exports"
branch_labels = None
depends_on = None


def identity():
    return [
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    ]


def upgrade():
    # Stable reference identities can now point to a pending imported description.
    # The resolved file_id remains a real media_files foreign key.
    op.drop_constraint(
        "shot_reference_versions_ref_id_fkey", "shot_reference_versions", type_="foreignkey"
    )
    op.create_table(
        "board_import_previews",
        *identity(),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "source_version_id", sa.UUID(), sa.ForeignKey("content_versions.id"), nullable=False
        ),
        sa.Column("base_version_id", sa.UUID(), sa.ForeignKey("content_versions.id")),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("package", postgresql.JSONB(), nullable=False),
        sa.Column("overrides", postgresql.JSONB(), nullable=False),
        sa.Column("result", postgresql.JSONB()),
    )
    op.create_index("ix_board_import_previews_project_id", "board_import_previews", ["project_id"])
    op.create_table(
        "board_import_commits",
        *identity(),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "preview_id", sa.UUID(), sa.ForeignKey("board_import_previews.id"), nullable=False
        ),
        sa.Column("key", sa.String(128), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.UniqueConstraint("project_id", "key"),
    )
    op.create_index("ix_board_import_commits_project_id", "board_import_commits", ["project_id"])
    op.create_table(
        "board_import_assets",
        *identity(),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column(
            "board_version_id", sa.UUID(), sa.ForeignKey("content_versions.id"), nullable=False
        ),
        sa.Column("shot_id", sa.UUID(), sa.ForeignKey("content_identities.id"), nullable=False),
        sa.Column("entity_version_id", sa.UUID(), sa.ForeignKey("entity_versions.id")),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
    )
    op.create_index("ix_board_import_assets_project_id", "board_import_assets", ["project_id"])
    op.create_index("ix_board_import_assets_shot_id", "board_import_assets", ["shot_id"])


def downgrade():
    # Old application versions cannot represent imported pending references. Never
    # silently discard an imported board's descriptors during an online downgrade.
    op.execute(
        "DO $$ BEGIN IF EXISTS (SELECT 1 FROM board_import_previews WHERE result IS NOT NULL) THEN RAISE EXCEPTION 'Committed imports exist; restore the pre-upgrade backup instead of downgrading'; END IF; END $$"
    )
    op.create_foreign_key(
        "shot_reference_versions_ref_id_fkey",
        "shot_reference_versions",
        "media_files",
        ["ref_id"],
        ["id"],
    )
    op.drop_table("board_import_assets")
    op.drop_table("board_import_commits")
    op.drop_table("board_import_previews")
