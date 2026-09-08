"""Versioned settings and text resources; preserve existing project specifications."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "20260908_configuration"
down_revision = "20260908_m1_story"
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
        "configuration_resources",
        *identity(),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("stage", sa.String(100), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.UniqueConstraint("name", "kind", "stage"),
    )
    op.create_table(
        "configuration_resource_versions",
        *identity(),
        sa.Column(
            "resource_id", sa.UUID(), sa.ForeignKey("configuration_resources.id"), nullable=False
        ),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("required_variables", JSONB(), nullable=False),
        sa.UniqueConstraint("resource_id", "revision"),
    )
    op.create_table(
        "configuration_bindings",
        *identity(),
        sa.Column("scope", sa.String(100), nullable=False),
        sa.Column("key", sa.String(150), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("value", JSONB()),
        sa.UniqueConstraint("scope", "key", "revision"),
    )
    op.execute("""UPDATE projects SET generation_settings =
        '{"aspect_ratio":"9:16","resolution":"1080P","revision": 1}'::jsonb || COALESCE(generation_settings, '{}'::jsonb) ||
        jsonb_build_object('migration_source','20260908_configuration:missing_fields_only')
        WHERE generation_settings IS NULL OR NOT (generation_settings ?& ARRAY['aspect_ratio','resolution','revision'])""")


def downgrade():
    op.drop_table("configuration_bindings")
    op.drop_table("configuration_resource_versions")
    op.drop_table("configuration_resources")
