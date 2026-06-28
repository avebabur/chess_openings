import sys
import unittest
from pathlib import Path
from unittest.mock import patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import sync_service


class AccountSyncServiceTests(unittest.TestCase):
    def test_job_progress_and_warning_completion_are_persisted(self):
        service = sync_service.AccountSyncService()
        updates = []

        def fake_sync(_account, progress, cancelled):
            self.assertFalse(cancelled())
            progress(seen=40, imported=3, total=None, warnings=["one archive failed"])
            return {"seen": 40, "imported": 3, "warnings": ["one archive failed"]}

        with (
            patch.object(sync_service.db, "get_sync_job", return_value={
                "id": "job", "account_id": 1, "status": "queued",
            }),
            patch.object(sync_service.db, "get_account", return_value={
                "id": 1, "platform": "chesscom", "username": "player",
            }),
            patch.object(sync_service.db, "sync_job_cancel_requested", return_value=False),
            patch.object(sync_service.db, "update_sync_job", side_effect=lambda job_id, **kw: updates.append(kw)),
            patch.object(sync_service.game_import, "sync_account", side_effect=fake_sync),
            patch.object(sync_service.opening_tree, "invalidate_cache") as invalidate,
        ):
            service._run_job("job")

        self.assertEqual(updates[0]["status"], "running")
        self.assertEqual(updates[-1]["status"], "warning")
        self.assertEqual(updates[-1]["imported"], 3)
        invalidate.assert_called_once()

    def test_cache_invalidated_with_account_id_when_sync_fails_midway(self):
        # A sync that imports some games then fails still mutated the DB, so the
        # opening-tree cache must be invalidated (scoped to that account) — else
        # the imported-so-far games stay invisible until the next success.
        service = sync_service.AccountSyncService()

        def failing_sync(_account, progress, cancelled):
            progress(seen=10, imported=5)
            raise RuntimeError("network dropped mid-import")

        with (
            patch.object(sync_service.db, "get_sync_job", return_value={
                "id": "job", "account_id": 7, "status": "queued",
            }),
            patch.object(sync_service.db, "get_account", return_value={
                "id": 7, "platform": "chesscom", "username": "player",
            }),
            patch.object(sync_service.db, "sync_job_cancel_requested", return_value=False),
            patch.object(sync_service.db, "update_sync_job") as update,
            patch.object(sync_service.game_import, "sync_account", side_effect=failing_sync),
            patch.object(sync_service.opening_tree, "invalidate_cache") as invalidate,
        ):
            service._run_job("job")

        self.assertEqual(update.call_args_list[-1].kwargs["status"], "failed")
        invalidate.assert_called_once_with(7)

    def test_cancelled_queued_job_never_calls_upstream(self):
        service = sync_service.AccountSyncService()
        with (
            patch.object(sync_service.db, "get_sync_job", return_value={
                "id": "job", "account_id": 1, "status": "queued",
            }),
            patch.object(sync_service.db, "sync_job_cancel_requested", return_value=True),
            patch.object(sync_service.db, "update_sync_job") as update,
            patch.object(sync_service.game_import, "sync_account") as upstream,
        ):
            service._run_job("job")
        update.assert_called_once_with("job", status="cancelled")
        upstream.assert_not_called()


if __name__ == "__main__":
    unittest.main()
