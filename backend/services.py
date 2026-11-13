"""Application-lifespan owners for database initialization and HTTP pools."""
import httpx

import database
import lichess_tablebase


class SQLiteService:
    """Own SQLite startup and online backup operations for one local app."""

    def start(self):
        database.init_db()

    def connect(self):
        return database.get_db()

    def backup(self, target_path):
        return database.create_database_backup(target_path)

    def close(self):
        # Repositories use short transactions/connections, so there is no shared
        # connection to close at shutdown.
        return None


class ExternalApiClients:
    """Shared connection pools for all outbound APIs during an app lifespan."""

    def __init__(self):
        self.http = httpx.Client(follow_redirects=True)

    def tablebase(self, fen, allow_network=True):
        return lichess_tablebase.get_tablebase(fen, allow_network, client=self.http)

    @property
    def import_client(self):
        return self.http

    def close(self):
        self.http.close()
