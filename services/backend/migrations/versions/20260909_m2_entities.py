"""Add versioned project elements without changing accepted M1 content."""

from alembic import op
import sqlalchemy as sa

revision = "20260909_m2_entities"
down_revision = "20260908_m1_content"
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
        "project_entities",
        *identity(),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.CheckConstraint("kind in ('character','scene','prop')"),
        sa.CheckConstraint("revision > 0"),
    )
    op.create_index("ix_project_entities_project_id", "project_entities", ["project_id"])
    op.create_table(
        "entity_versions",
        *identity(),
        sa.Column("entity_id", sa.UUID(), sa.ForeignKey("project_entities.id"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("voice", sa.String(200), nullable=False),
        sa.Column("three_view", sa.Boolean(), nullable=False),
        sa.UniqueConstraint("entity_id", "revision"),
    )
    op.create_index("ix_entity_versions_entity_id", "entity_versions", ["entity_id"])


def downgrade():
    op.drop_table("entity_versions")
    op.drop_table("project_entities")
