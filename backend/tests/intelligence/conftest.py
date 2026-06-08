import pytest
from sqlmodel import SQLModel, Session, create_engine

import app.models  # noqa: F401 — register all tables


@pytest.fixture()
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s
