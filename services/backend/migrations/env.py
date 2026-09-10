from alembic import context
from shortfilm.db import engine
from shortfilm.models import Base
from shortfilm.assets import models as asset_models  # noqa: F401
from shortfilm.media import models as media_models  # noqa: F401
from shortfilm.finishing import models as finishing_models  # noqa: F401
from shortfilm.creation import board_import_models  # noqa: F401
from shortfilm import config_models  # noqa: F401

if context.is_offline_mode():
    context.configure(url=str(engine.url), target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=Base.metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()
