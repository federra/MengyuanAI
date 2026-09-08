"""Versioned configuration resources shared by settings and the asset library."""

from uuid import UUID

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from shortfilm.models import Base, Identity


class Resource(Identity, Base):
    __tablename__ = "configuration_resources"
    name: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(20))
    stage: Mapped[str] = mapped_column(String(100))
    revision: Mapped[int] = mapped_column(default=1)
    __table_args__ = (UniqueConstraint("name", "kind", "stage"),)


class ResourceVersion(Identity, Base):
    __tablename__ = "configuration_resource_versions"
    resource_id: Mapped[UUID] = mapped_column(ForeignKey("configuration_resources.id"))
    revision: Mapped[int]
    name: Mapped[str] = mapped_column(String(100))
    content: Mapped[str] = mapped_column(Text)
    required_variables: Mapped[list] = mapped_column(JSONB, default=list)
    __table_args__ = (UniqueConstraint("resource_id", "revision"),)


class Binding(Identity, Base):
    __tablename__ = "configuration_bindings"
    scope: Mapped[str] = mapped_column(String(100))
    key: Mapped[str] = mapped_column(String(150))
    revision: Mapped[int]
    value: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    __table_args__ = (UniqueConstraint("scope", "key", "revision"),)
