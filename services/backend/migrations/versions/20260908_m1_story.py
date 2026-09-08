"""M1 story versions and proposals; additive to M0."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

revision = "20260908_m1_story"
down_revision = "06c86e6029af"
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
    op.add_column("job_attempts", sa.Column("provider_calls", pg.JSONB()))
    op.create_table(
        "content_items",
        *identity(),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("batch_id", sa.UUID(), sa.ForeignKey("generation_jobs.id")),
        sa.Column("revision", sa.Integer(), nullable=False),
    )
    op.create_index("ix_content_items_project_id", "content_items", ["project_id"])
    op.create_index(
        "uq_project_idea",
        "content_items",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'idea'"),
    )
    op.create_table(
        "content_versions",
        *identity(),
        sa.Column("item_id", sa.UUID(), sa.ForeignKey("content_items.id"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("body", pg.JSONB(), nullable=False),
        sa.Column("source_version_id", sa.UUID(), sa.ForeignKey("content_versions.id")),
        sa.Column("job_id", sa.UUID(), sa.ForeignKey("generation_jobs.id")),
        sa.Column("origin", sa.String(20), nullable=False),
        sa.UniqueConstraint("item_id", "revision"),
        sa.CheckConstraint("revision > 0"),
    )
    op.create_index("ix_content_versions_item_id", "content_versions", ["item_id"])
    op.create_table(
        "story_selections",
        *identity(),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("version_id", sa.UUID(), sa.ForeignKey("content_versions.id")),
        sa.UniqueConstraint("project_id", "revision"),
    )
    op.create_index("ix_story_selections_project_id", "story_selections", ["project_id"])
    op.create_table(
        "messages",
        *identity(),
        sa.Column("item_id", sa.UUID(), sa.ForeignKey("content_items.id"), nullable=False),
        sa.Column("job_id", sa.UUID(), sa.ForeignKey("generation_jobs.id"), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.UniqueConstraint("job_id", "role"),
    )
    op.create_index("ix_messages_item_id", "messages", ["item_id"])
    op.create_table(
        "proposals",
        *identity(),
        sa.Column("item_id", sa.UUID(), sa.ForeignKey("content_items.id"), nullable=False),
        sa.Column(
            "job_id", sa.UUID(), sa.ForeignKey("generation_jobs.id"), nullable=False, unique=True
        ),
        sa.Column(
            "base_version_id", sa.UUID(), sa.ForeignKey("content_versions.id"), nullable=False
        ),
        sa.Column("output", pg.JSONB(), nullable=False),
        sa.Column("applied_version_id", sa.UUID(), sa.ForeignKey("content_versions.id")),
    )
    op.create_index("ix_proposals_item_id", "proposals", ["item_id"])


def downgrade():
    for name in ["proposals", "messages", "story_selections", "content_versions", "content_items"]:
        op.drop_table(name)
    op.drop_column("job_attempts", "provider_calls")
