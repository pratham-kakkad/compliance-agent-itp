import pytest
import sqlalchemy
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.database import Base, get_db
from app.directory import STUB_DIRECTORY
from app.main import app
from app.models import OrgUser

# Tests run against a dedicated *_test database, never the dev DB the demo
# data lives in — the fixture below drops/recreates its tables every run.
_TEST_DATABASE_URL = settings.database_url.rsplit("/", 1)[0] + "/meeting_compliance_test"


def _ensure_test_database_exists() -> None:
    admin_engine = create_engine(settings.database_url.rsplit("/", 1)[0] + "/postgres")
    with admin_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        exists = conn.execute(
            sqlalchemy.text("SELECT 1 FROM pg_database WHERE datname = 'meeting_compliance_test'")
        ).scalar()
        if not exists:
            conn.execute(sqlalchemy.text("CREATE DATABASE meeting_compliance_test"))
    admin_engine.dispose()


@pytest.fixture(scope="session")
def engine():
    _ensure_test_database_exists()
    eng = create_engine(_TEST_DATABASE_URL)
    Base.metadata.create_all(eng)
    yield eng
    Base.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture
def db_session(engine):
    connection = engine.connect()
    transaction = connection.begin()
    Session = sessionmaker(bind=connection, join_transaction_mode="create_savepoint")
    session = Session()

    for entry in STUB_DIRECTORY:
        session.add(OrgUser(**entry))
    session.commit()

    yield session

    session.close()
    transaction.rollback()
    connection.close()


@pytest.fixture
def client(db_session):
    def _get_db_override():
        yield db_session

    app.dependency_overrides[get_db] = _get_db_override
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def login_as(client: TestClient, email: str) -> None:
    from app.auth.session import COOKIE_NAME, create_session_cookie

    client.cookies.set(COOKIE_NAME, create_session_cookie(email))
