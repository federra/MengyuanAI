"""Persist media receipts, outcomes and dependencies separately from frozen jobs."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "20260909_m2_media"
down_revision = "20260909_m2_references"
branch_labels = None
depends_on = None


def identity():
    return [
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def fk(name, target, nullable=False, primary_key=False):
    return sa.Column(
        name, sa.UUID(), sa.ForeignKey(target), nullable=nullable, primary_key=primary_key
    )


def upgrade():
    op.create_table(
        "media_sequences",
        *identity(),
        fk("project_id", "projects.id"),
        sa.Column("paused", sa.Boolean(), nullable=False),
    )
    op.create_index("ix_media_sequences_project_id", "media_sequences", ["project_id"])
    op.create_table(
        "media_runs",
        fk("job_id", "generation_jobs.id", primary_key=True),
        fk("sequence_id", "media_sequences.id", nullable=True),
        sa.Column("external_id", sa.String(200)),
        sa.Column("submitted", sa.Boolean(), nullable=False),
        sa.Column("receipt", JSONB()),
        sa.Column("previous", JSONB()),
        sa.Column("next_poll_at", sa.DateTime(timezone=True)),
        sa.Column("cancelled", sa.Boolean(), nullable=False),
    )
    op.create_index("ix_media_runs_sequence_id", "media_runs", ["sequence_id"])
    op.create_table(
        "job_dependencies",
        fk("child_id", "generation_jobs.id", primary_key=True),
        fk("parent_id", "generation_jobs.id"),
    )
    op.create_index("ix_job_dependencies_parent_id", "job_dependencies", ["parent_id"])
    op.create_table(
        "media_outcomes",
        *identity(),
        fk("project_id", "projects.id"),
        fk("job_id", "generation_jobs.id"),
        sa.Column("kind", sa.String(30), nullable=False),
        sa.Column("target_id", sa.String(100), nullable=False),
        fk("file_id", "media_files.id"),
        fk("tail_file_id", "media_files.id", nullable=True),
        sa.Column("metadata_json", JSONB(), nullable=False),
        sa.Column("confirmation_revision", sa.Integer()),
        sa.UniqueConstraint("job_id"),
    )
    op.create_index("ix_media_outcomes_project_id", "media_outcomes", ["project_id"])
    op.create_index("ix_media_outcomes_target_id", "media_outcomes", ["target_id"])
    op.create_table(
        "line_bindings",
        fk("line_id", "content_identities.id", primary_key=True),
        fk("project_id", "projects.id"),
        fk("entity_id", "project_entities.id", nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False),
    )
    op.create_index("ix_line_bindings_project_id", "line_bindings", ["project_id"])
    op.create_table(
        "previous_frame_bindings",
        *identity(),
        fk("project_id", "projects.id"),
        fk("shot_id", "content_identities.id"),
        fk("outcome_id", "media_outcomes.id"),
        sa.UniqueConstraint("shot_id", "outcome_id"),
    )
    op.create_index(
        "ix_previous_frame_bindings_project_id", "previous_frame_bindings", ["project_id"]
    )


def downgrade():
    for table in (
        "previous_frame_bindings",
        "line_bindings",
        "media_outcomes",
        "job_dependencies",
        "media_runs",
        "media_sequences",
    ):
        op.drop_table(table)
