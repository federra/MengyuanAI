from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from shortfilm.config import settings

engine = create_engine(
    settings.database_url, pool_pre_ping=True, connect_args={"connect_timeout": 5}
)
Session = sessionmaker(engine, expire_on_commit=False)


def session():
    with Session() as db:
        yield db
