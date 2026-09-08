"""Advisory reports, confirmations and stable storyboard identities."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "20260908_m1_content"
down_revision = "20260908_configuration"
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
        "content_reviews",
        *identity(),
        sa.Column("item_id", sa.UUID(), sa.ForeignKey("content_items.id"), nullable=False),
        sa.Column("version_id", sa.UUID(), sa.ForeignKey("content_versions.id"), nullable=False),
        sa.Column("source_version_id", sa.UUID(), sa.ForeignKey("content_versions.id")),
        sa.Column("job_id", sa.UUID(), sa.ForeignKey("generation_jobs.id"), unique=True),
        sa.Column("output", JSONB()),
        sa.Column("error", sa.String(200)),
    )
    op.create_index("ix_content_reviews_item_id", "content_reviews", ["item_id"])
    op.create_table(
        "content_confirmations",
        *identity(),
        sa.Column("item_id", sa.UUID(), sa.ForeignKey("content_items.id"), nullable=False),
        sa.Column("version_id", sa.UUID(), sa.ForeignKey("content_versions.id"), nullable=False),
        sa.Column("source_version_id", sa.UUID(), sa.ForeignKey("content_versions.id")),
        sa.Column("decision", sa.String(30), nullable=False),
        sa.Column("report_id", sa.UUID(), sa.ForeignKey("content_reviews.id")),
        sa.Column("report_state", sa.String(30), nullable=False),
    )
    op.create_index("ix_content_confirmations_item_id", "content_confirmations", ["item_id"])
    op.create_table(
        "content_identities",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("item_id", sa.UUID(), sa.ForeignKey("content_items.id"), nullable=False),
        sa.Column("parent_id", sa.UUID()),
        sa.Column("kind", sa.String(10), nullable=False),
    )
    op.create_index(
        "uq_project_script",
        "content_items",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'script'"),
    )
    op.create_index(
        "uq_project_board",
        "content_items",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'board'"),
    )


def downgrade():
    op.drop_index("uq_project_board", table_name="content_items")
    op.drop_index("uq_project_script", table_name="content_items")
    op.drop_table("content_identities")
    op.drop_table("content_confirmations")
    op.drop_table("content_reviews")
