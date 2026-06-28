"""Single-worker, persisted account synchronization service."""
import queue
import threading
import logging

import database as db
import game_import
import opening_tree

log = logging.getLogger("account_sync")


class AccountSyncService:
    def __init__(self, invalidate_cache=None, import_client=None):
        self._queue = queue.Queue()
        self._stopping = threading.Event()
        self._worker = None
        self._invalidate_cache = invalidate_cache
        self._import_client = import_client

    def start(self):
        if self._worker and self._worker.is_alive():
            return
        self._stopping.clear()
        self._worker = threading.Thread(
            target=self._run, name="account-sync", daemon=True,
        )
        self._worker.start()
        for job in db.recover_sync_jobs():
            self._queue.put(job["id"])

    def enqueue(self, account_id):
        job, created = db.create_sync_job(account_id)
        if created:
            self._queue.put(job["id"])
        return job

    def cancel(self, job_id):
        return db.request_sync_job_cancel(job_id)

    def shutdown(self):
        self._stopping.set()
        self._queue.put(None)
        if self._worker:
            self._worker.join(timeout=3)
        self._worker = None

    def _cancelled(self, job_id):
        return self._stopping.is_set() or db.sync_job_cancel_requested(job_id)

    def _run(self):
        while not self._stopping.is_set():
            job_id = self._queue.get()
            if job_id is None:
                return
            self._run_job(job_id)

    def _run_job(self, job_id):
        job = db.get_sync_job(job_id)
        if not job or job["status"] != "queued":
            return
        if self._cancelled(job_id):
            db.update_sync_job(job_id, status="cancelled")
            return
        account = db.get_account(job["account_id"])
        if not account:
            db.update_sync_job(job_id, status="failed", error="Account not found")
            return

        db.update_sync_job(job_id, status="running", error="")

        def progress(**values):
            db.update_sync_job(job_id, **values)

        # Once we're past "running" the importer may have written games. A sync
        # that imports some games then fails/cancels still mutated the DB, so the
        # cache must be invalidated regardless of outcome — otherwise those games
        # stay invisible in the opening tree until the next successful sync.
        try:
            try:
                kwargs = {
                    "progress": progress,
                    "cancelled": lambda: self._cancelled(job_id),
                }
                if self._import_client is not None:
                    kwargs["client"] = self._import_client
                result = game_import.sync_account(account, **kwargs)
            except game_import.SyncCancelled:
                db.update_sync_job(job_id, status="cancelled")
                return
            except game_import.ImportError_ as exc:
                db.update_sync_job(job_id, status="failed", error=str(exc))
                return
            except Exception:
                log.exception("Unexpected account sync failure for job %s", job_id)
                db.update_sync_job(
                    job_id, status="failed", error="Unexpected sync failure; check the server log",
                )
                return

            warnings = result.get("warnings") or []
            db.update_sync_job(
                job_id,
                status="warning" if warnings else "completed",
                seen=result.get("seen", 0),
                imported=result.get("imported", 0),
                warnings=warnings,
                error="",
            )
        finally:
            self._invalidate(job["account_id"])

    def _invalidate(self, account_id):
        if self._invalidate_cache is not None:
            self._invalidate_cache(account_id)
        else:
            opening_tree.invalidate_cache(account_id)
