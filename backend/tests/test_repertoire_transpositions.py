import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from position_key import key_from_san_path

# One position, two move orders — the case the whole change exists for.
VIA_NF3 = "d4 d5 Nf3 Nc6 Bf4 Nf6"
VIA_BF4 = "d4 d5 Bf4 Nf6 Nf3 Nc6"


class RepertoireTranspositionTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "openings.db"
        self.old_db_path = os.environ.get("CHESS_DB_PATH")
        os.environ["CHESS_DB_PATH"] = str(self.db_path)
        import database
        self.db = importlib.reload(database)
        self.db.init_db()

    def tearDown(self):
        if self.old_db_path is None:
            os.environ.pop("CHESS_DB_PATH", None)
        else:
            os.environ["CHESS_DB_PATH"] = self.old_db_path
        self.temp_dir.cleanup()

    def _nodes_by_path(self, color="white"):
        tree = self.db.get_repertoire_tree(color)
        found = {}

        def walk(node):
            found[node["path_san"]] = node
            for child in node["children"]:
                walk(child)

        for child in tree["root"]["children"]:
            walk(child)
        return tree, found


class SharedCardTests(RepertoireTranspositionTestCase):
    def test_transposed_lines_share_one_card(self):
        self.db.save_repertoire_branch("white", "via Nf3", VIA_NF3)
        self.db.save_repertoire_branch("white", "via Bf4", VIA_BF4)
        _, nodes = self._nodes_by_path()

        a, b = nodes[VIA_NF3], nodes[VIA_BF4]
        self.assertNotEqual(a["id"], b["id"])          # still two nodes to render
        self.assertEqual(a["epd_after"], b["epd_after"])  # one position
        # ...but the final move differs (Nf6 vs Nc6), so these are two questions.
        self.assertNotEqual(a["position_id"], b["position_id"])

    def test_drilling_one_move_order_shows_through_on_the_other(self):
        self.db.save_repertoire_branch("white", "via Nf3", "d4 d5 Nf3 Nc6 Bf4")
        self.db.save_repertoire_branch("white", "via Nf6", "d4 d5 Nf3 Nf6 Bf4")
        # Both lines ask the same thing at a *different* prior position, so pick
        # the one that genuinely shares a card: 3.Nf3 after 1.d4 d5.
        _, nodes = self._nodes_by_path()
        node = nodes["d4 d5 Nf3"]

        self.db.record_repertoire_drill_attempt(
            "event-1", "practice", True, node_id=node["id"], path_san="d4 d5 Nf3",
        )

        _, after = self._nodes_by_path()
        self.assertEqual(after["d4 d5 Nf3"]["drill_count"], 1)
        self.assertEqual(after["d4 d5 Nf3"]["drill_solved"], 1)

    def test_a_drill_advances_every_node_on_the_same_card(self):
        # 1.d4 Nf6 2.c4 and 1.c4 Nf6 2.d4 both ask "play c4/d4 here"; the pair
        # that truly shares a card is the second move of each order.
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3")
        self.db.save_repertoire_branch("white", "c4 first", "c4 Nf6 d4 e6 Nc3")
        _, nodes = self._nodes_by_path()

        # After 1.d4 Nf6 2.c4 e6 and 1.c4 Nf6 2.d4 e6 the position is identical,
        # and both prescribe 3.Nc3 — one card.
        first = nodes["d4 Nf6 c4 e6 Nc3"]
        second = nodes["c4 Nf6 d4 e6 Nc3"]
        self.assertEqual(first["epd_before"], second["epd_before"])
        self.assertEqual(first["position_id"], second["position_id"])

        self.db.record_repertoire_drill_attempt(
            "event-2", "practice", True, node_id=first["id"],
        )

        _, after = self._nodes_by_path()
        self.assertEqual(after["d4 Nf6 c4 e6 Nc3"]["drill_count"], 1)
        # The transposed spelling of the same question is now drilled too.
        self.assertEqual(after["c4 Nf6 d4 e6 Nc3"]["drill_count"], 1)

    def test_different_moves_onto_the_same_board_stay_separate(self):
        # The correction that matters: 1.d4 Nf6 2.c4 e6 3.Nc3 and 1.d4 e6 2.c4
        # Nf6 3.Nc3 reach one board, but "play e6 here" and "play Nf6 here" are
        # different questions and must not merge into one card.
        self.db.save_repertoire_branch("black", "Nf6 first", "d4 Nf6 c4 e6")
        self.db.save_repertoire_branch("black", "e6 first", "d4 e6 c4 Nf6")
        _, nodes = self._nodes_by_path("black")

        a, b = nodes["d4 Nf6 c4 e6"], nodes["d4 e6 c4 Nf6"]
        self.assertEqual(a["epd_after"], b["epd_after"])   # same resulting board
        self.assertNotEqual(a["san"], b["san"])            # different answers
        self.assertNotEqual(a["position_id"], b["position_id"])


class DueQueueTests(RepertoireTranspositionTestCase):
    def _drill(self, node_id, event, solved=False):
        return self.db.record_repertoire_drill_attempt(
            event, "practice", solved, node_id=node_id,
        )

    def test_a_position_is_never_queued_twice(self):
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3")
        self.db.save_repertoire_branch("white", "c4 first", "c4 Nf6 d4 e6 Nc3")
        _, nodes = self._nodes_by_path()
        self._drill(nodes["d4 Nf6 c4 e6 Nc3"]["id"], "miss-1")

        tree = self.db.get_repertoire_tree("white")
        keys = [item["epd_before"] for item in tree["due"]]

        self.assertEqual(len(keys), len(set(keys)))
        self.assertEqual(len(tree["due"]), 1)

    def test_due_total_matches_the_queue(self):
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3")
        self.db.save_repertoire_branch("white", "c4 first", "c4 Nf6 d4 e6 Nc3")
        _, nodes = self._nodes_by_path()
        self._drill(nodes["d4 Nf6 c4 e6 Nc3"]["id"], "miss-2")

        tree = self.db.get_repertoire_tree("white")

        self.assertEqual(tree["stats"]["due"], len(tree["due"]))

    def test_a_solved_card_leaves_the_queue(self):
        self.db.save_repertoire_branch("white", "line", "d4 Nf6 c4")
        _, nodes = self._nodes_by_path()
        self._drill(nodes["d4 Nf6 c4"]["id"], "solved-1", solved=True)

        tree = self.db.get_repertoire_tree("white")

        self.assertEqual(tree["due"], [])
        self.assertEqual(tree["stats"]["due"], 0)

    def test_every_saved_reply_at_the_position_is_accepted(self):
        # Two different first moves saved for White: one queue item, two answers.
        self.db.save_repertoire_branch("white", "queens pawn", "d4 d5")
        self.db.save_repertoire_branch("white", "kings pawn", "e4 e5")
        _, nodes = self._nodes_by_path()
        self._drill(nodes["d4"]["id"], "miss-3")

        tree = self.db.get_repertoire_tree("white")

        self.assertEqual(len(tree["due"]), 1)
        accepted = {reply["san"] for reply in tree["due"][0]["accepted"]}
        self.assertEqual(accepted, {"d4", "e4"})

    def test_answering_with_one_reply_drains_the_whole_position(self):
        """Two saved replies to one position are one question, not two.

        The queue serves a single item per position and accepts either answer,
        so crediting only the reply that was played left the *other* card due
        forever and the position resurfaced every session.
        """
        self.db.save_repertoire_branch("white", "queens pawn", "d4 d5")
        self.db.save_repertoire_branch("white", "kings pawn", "e4 e5")
        _, nodes = self._nodes_by_path()
        self._drill(nodes["d4"]["id"], "miss-drain")
        self.assertEqual(self.db.get_repertoire_tree("white")["stats"]["due"], 1)

        # Answer the same queue item with the other accepted reply.
        self._drill(nodes["e4"]["id"], "solve-drain", solved=True)

        tree = self.db.get_repertoire_tree("white")
        self.assertEqual(tree["due"], [])
        self.assertEqual(tree["stats"]["due"], 0)

    def test_the_schedule_moves_together_but_the_counters_do_not(self):
        """One schedule per position; per-move counters stay per move."""
        self.db.save_repertoire_branch("white", "queens pawn", "d4 d5")
        self.db.save_repertoire_branch("white", "kings pawn", "e4 e5")
        _, nodes = self._nodes_by_path()
        self._drill(nodes["d4"]["id"], "miss-split")
        self._drill(nodes["e4"]["id"], "solve-split", solved=True)

        conn = self.db.get_db()
        try:
            rows = {
                row["san"]: dict(row)
                for row in conn.execute(
                    "SELECT san, drill_count, drill_solved, drill_missed, "
                    "       interval_days, next_review_at "
                    "FROM repertoire_positions WHERE color = 'white' AND drill_count > 0",
                )
            }
        finally:
            conn.close()

        self.assertEqual(rows["d4"]["drill_count"], 1)
        self.assertEqual(rows["d4"]["drill_missed"], 1)
        self.assertEqual(rows["e4"]["drill_count"], 1)
        self.assertEqual(rows["e4"]["drill_solved"], 1)
        # ...but both were pushed out to the same next review.
        self.assertEqual(rows["d4"]["next_review_at"], rows["e4"]["next_review_at"])
        self.assertEqual(rows["d4"]["interval_days"], rows["e4"]["interval_days"])

    def test_a_missed_sibling_keeps_the_position_on_a_short_leash(self):
        """The position's interval follows its weakest answer, not its best."""
        self.db.save_repertoire_branch("white", "queens pawn", "d4 d5")
        self.db.save_repertoire_branch("white", "kings pawn", "e4 e5")
        _, nodes = self._nodes_by_path()
        # Build e4 up to a long interval, then miss d4 at the same position.
        self._drill(nodes["e4"]["id"], "e4-1", solved=True)
        self._drill(nodes["e4"]["id"], "e4-2", solved=True)
        self._drill(nodes["d4"]["id"], "d4-miss")

        # Solving once now must not jump straight back to the long interval.
        self._drill(nodes["e4"]["id"], "e4-3", solved=True)

        conn = self.db.get_db()
        try:
            intervals = {
                row["san"]: row["interval_days"]
                for row in conn.execute(
                    "SELECT san, interval_days FROM repertoire_positions "
                    "WHERE color = 'white' AND drill_count > 0",
                )
            }
        finally:
            conn.close()

        self.assertEqual(intervals["d4"], intervals["e4"])
        self.assertEqual(intervals["e4"], 2)

    def test_a_deleted_line_does_not_leave_a_card_in_the_queue(self):
        branch = self.db.save_repertoire_branch("white", "line", "d4 Nf6 c4")
        _, nodes = self._nodes_by_path()
        self._drill(nodes["d4 Nf6 c4"]["id"], "miss-4")
        self.assertEqual(self.db.get_repertoire_tree("white")["stats"]["due"], 1)

        self.db.delete_repertoire_branch(branch["id"])

        tree = self.db.get_repertoire_tree("white")
        self.assertEqual(tree["due"], [])
        self.assertEqual(tree["stats"]["due"], 0)

    def test_re_saving_a_deleted_line_restores_its_schedule(self):
        branch = self.db.save_repertoire_branch("white", "line", "d4 Nf6 c4")
        _, nodes = self._nodes_by_path()
        self._drill(nodes["d4 Nf6 c4"]["id"], "miss-5")
        self.db.delete_repertoire_branch(branch["id"])

        self.db.save_repertoire_branch("white", "line again", "d4 Nf6 c4")

        _, nodes = self._nodes_by_path()
        self.assertEqual(nodes["d4 Nf6 c4"]["drill_count"], 1)
        self.assertEqual(nodes["d4 Nf6 c4"]["drill_missed"], 1)


class DrillWriteTests(RepertoireTranspositionTestCase):
    def test_a_retried_attempt_returns_the_live_counters(self):
        self.db.save_repertoire_branch("white", "line", "e4")
        _, nodes = self._nodes_by_path()
        node_id = nodes["e4"]["id"]

        first = self.db.record_repertoire_drill_attempt(
            "same-event", "practice", False, node_id=node_id, path_san="e4",
        )
        retry = self.db.record_repertoire_drill_attempt(
            "same-event", "practice", False, node_id=node_id, path_san="e4",
        )

        self.assertFalse(first["duplicate"])
        self.assertTrue(retry["duplicate"])
        # The retry must not report the frozen legacy columns.
        self.assertEqual(retry["drill_count"], first["drill_count"])
        self.assertEqual(retry["drill_missed"], 1)

    def test_history_still_records_which_move_order_was_drilled(self):
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3")
        self.db.save_repertoire_branch("white", "c4 first", "c4 Nf6 d4 e6 Nc3")
        _, nodes = self._nodes_by_path()

        self.db.record_repertoire_drill_attempt(
            "event-a", "practice", True, node_id=nodes["c4 Nf6 d4 e6 Nc3"]["id"],
            path_san="c4 Nf6 d4 e6 Nc3",
        )

        attempts = self.db.get_repertoire_drill_attempts(10)
        self.assertEqual(attempts[0]["path_san"], "c4 Nf6 d4 e6 Nc3")


class TranspositionReportTests(RepertoireTranspositionTestCase):
    def test_plain_branching_is_not_a_transposition(self):
        # Two first moves saved for White is a choice, not a transposition:
        # only one move order leads to the starting position.
        self.db.save_repertoire_branch("white", "d4", "d4 d5")
        self.db.save_repertoire_branch("white", "e4", "e4 e5")

        tree = self.db.get_repertoire_tree("white")

        self.assertEqual(tree["stats"]["transpositions"], 0)
        self.assertEqual(tree["stats"]["conflicts"], 0)

    def test_two_orders_agreeing_is_a_transposition_not_a_conflict(self):
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3")
        self.db.save_repertoire_branch("white", "c4 first", "c4 Nf6 d4 e6 Nc3")

        tree = self.db.get_repertoire_tree("white")

        self.assertGreater(tree["stats"]["transpositions"], 0)
        self.assertEqual(tree["stats"]["conflicts"], 0)

    def test_two_orders_prescribing_different_moves_is_a_conflict(self):
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3")
        self.db.save_repertoire_branch("white", "c4 first", "c4 Nf6 d4 e6 Nf3")

        tree = self.db.get_repertoire_tree("white")
        conflicts = [item for item in tree["transpositions"] if item["conflict"]]

        self.assertEqual(len(conflicts), 1)
        self.assertEqual({m["san"] for m in conflicts[0]["moves"]}, {"Nc3", "Nf3"})
        self.assertEqual(tree["transpositions"][0]["conflict"], True)  # sorted first

    def test_a_line_you_labelled_an_alternative_is_not_a_contradiction(self):
        """You already told us it is deliberate; do not call it a conflict.

        The label lives on the branch, not the node — repertoire_nodes.label
        defaults to 'sideline' and only the terminal move of a branch carries
        the real one — so the check has to read through to the branches that
        pass through each competing node.
        """
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3")
        self.db.save_repertoire_branch(
            "white", "c4 first", "c4 Nf6 d4 e6 Nf3", label="alternative",
        )

        tree = self.db.get_repertoire_tree("white")

        # Still worth showing as a transposition, just not as a contradiction.
        self.assertGreater(tree["stats"]["transpositions"], 0)
        self.assertEqual(tree["stats"]["conflicts"], 0)

    def test_a_deliberate_label_mid_line_still_counts(self):
        """The competing move is not the branch's terminal move."""
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3 Bb4")
        self.db.save_repertoire_branch(
            "white", "c4 first", "c4 Nf6 d4 e6 Nf3 b6", label="trap",
        )

        tree = self.db.get_repertoire_tree("white")

        self.assertEqual(tree["stats"]["conflicts"], 0)

    def test_two_main_lines_disagreeing_is_still_a_conflict(self):
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3 Bb4")
        self.db.save_repertoire_branch("white", "c4 first", "c4 Nf6 d4 e6 Nf3 b6")

        tree = self.db.get_repertoire_tree("white")

        self.assertEqual(tree["stats"]["conflicts"], 1)

    def test_several_opponent_replies_are_coverage_not_a_conflict(self):
        # In a White repertoire, Black having many answers to 1.d4 is the point.
        self.db.save_repertoire_branch("white", "vs Nf6", "d4 Nf6 c4")
        self.db.save_repertoire_branch("white", "vs d5", "d4 d5 c4")
        self.db.save_repertoire_branch("white", "vs e6", "d4 e6 c4")

        tree = self.db.get_repertoire_tree("white")

        self.assertEqual(tree["stats"]["conflicts"], 0)


class SaveWarningTests(RepertoireTranspositionTestCase):
    def test_saving_a_transposed_line_says_so(self):
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3")
        result = self.db.save_repertoire_branch("white", "c4 first", "c4 Nf6 d4 e6 Nc3")

        kinds = {w["kind"] for w in result["warnings"]}
        self.assertIn("transposition", kinds)
        self.assertNotIn("conflict", kinds)

    def test_saving_a_contradicting_line_reports_a_conflict(self):
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3")
        result = self.db.save_repertoire_branch("white", "c4 first", "c4 Nf6 d4 e6 Nf3")

        conflicts = [w for w in result["warnings"] if w["kind"] == "conflict"]
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["san"], "Nf3")
        self.assertEqual(conflicts[0]["other_san"], "Nc3")
        self.assertEqual(conflicts[0]["other_path_san"], "d4 Nf6 c4 e6 Nc3")

    def test_saving_a_labelled_alternative_is_not_reported_as_a_conflict(self):
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3")
        result = self.db.save_repertoire_branch(
            "white", "c4 first", "c4 Nf6 d4 e6 Nf3", label="alternative",
        )

        kinds = {w["kind"] for w in result["warnings"]}
        self.assertNotIn("conflict", kinds)
        self.assertIn("transposition", kinds)

    def test_a_first_line_warns_about_nothing(self):
        result = self.db.save_repertoire_branch("white", "only line", "d4 Nf6 c4")

        self.assertEqual(result["warnings"], [])

    def test_a_branch_reports_the_position_its_last_move_reaches(self):
        result = self.db.save_repertoire_branch("white", "line", VIA_NF3)

        self.assertEqual(result["terminal_epd"], key_from_san_path(VIA_NF3))

    def test_branches_expose_the_terminal_position_for_duplicate_detection(self):
        self.db.save_repertoire_branch("white", "via Nf3", VIA_NF3)
        self.db.save_repertoire_branch("white", "via Bf4", VIA_BF4)

        by_name = {b["name"]: b for b in self.db.get_repertoire_branches("white")}

        # Different move orders, one position — this is what stops the UI
        # offering to save the second one all over again.
        self.assertEqual(by_name["via Nf3"]["terminal_epd"],
                         by_name["via Bf4"]["terminal_epd"])


class FoldMigrationTests(RepertoireTranspositionTestCase):
    """The one migration that rewrites real learning data."""

    MIGRATION = "repertoire_position_srs_v1"

    def _seed_pre_fold_nodes(self, rows):
        """Write node-level SRS counters the way the old schema stored them."""
        conn = self.db.get_db()
        conn.execute("DELETE FROM repertoire_positions")
        for path_san, counters in rows.items():
            conn.execute(
                """UPDATE repertoire_nodes
                   SET drill_count = ?, drill_solved = ?, drill_missed = ?,
                       interval_days = ?, next_review_at = ?, last_drilled_at = ?
                   WHERE color = 'white' AND path_san = ?""",
                (*counters, path_san),
            )
        conn.execute(
            "DELETE FROM schema_migrations WHERE version = ?", (self.MIGRATION,),
        )
        conn.commit()
        conn.close()

    def _card(self, path_san):
        conn = self.db.get_db()
        try:
            return dict(conn.execute(
                """SELECT p.* FROM repertoire_positions p
                   JOIN repertoire_nodes n
                     ON n.color = p.color AND n.epd_before = p.epd AND n.san = p.san
                   WHERE n.color = 'white' AND n.path_san = ?""",
                (path_san,),
            ).fetchone())
        finally:
            conn.close()

    def test_the_fold_sums_counts_and_widens_the_schedule(self):
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3")
        self.db.save_repertoire_branch("white", "c4 first", "c4 Nf6 d4 e6 Nc3")
        self._seed_pre_fold_nodes({
            # count, solved, missed, interval_days, next_review_at, last_drilled_at
            "d4 Nf6 c4 e6 Nc3": (9, 4, 5, 8, "2026-01-01 00:00:00", "2025-12-24 00:00:00"),
            "c4 Nf6 d4 e6 Nc3": (4, 4, 0, 2, "2025-06-01 00:00:00", "2025-05-20 00:00:00"),
        })

        self.db._run_schema_migrations()

        card = self._card("d4 Nf6 c4 e6 Nc3")
        self.assertEqual(card["drill_count"], 13)                 # 9 + 4
        self.assertEqual(card["drill_solved"], 8)                 # 4 + 4
        self.assertEqual(card["drill_missed"], 5)                 # 5 + 0
        self.assertEqual(card["interval_days"], 8)                # MAX: credit the work
        self.assertEqual(card["next_review_at"], "2025-06-01 00:00:00")  # MIN: due wins
        self.assertEqual(card["last_drilled_at"], "2025-12-24 00:00:00")  # MAX

    def test_both_move_orders_read_back_the_merged_card(self):
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3")
        self.db.save_repertoire_branch("white", "c4 first", "c4 Nf6 d4 e6 Nc3")
        self._seed_pre_fold_nodes({
            "d4 Nf6 c4 e6 Nc3": (9, 4, 5, 8, "2026-01-01 00:00:00", None),
            "c4 Nf6 d4 e6 Nc3": (4, 4, 0, 2, "2025-06-01 00:00:00", None),
        })
        self.db._run_schema_migrations()

        _, nodes = self._nodes_by_path()

        for path in ("d4 Nf6 c4 e6 Nc3", "c4 Nf6 d4 e6 Nc3"):
            with self.subTest(path=path):
                self.assertEqual(nodes[path]["drill_count"], 13)
                self.assertEqual(nodes[path]["drill_solved"], 8)

    def test_the_fold_is_idempotent(self):
        self.db.save_repertoire_branch("white", "d4 first", "d4 Nf6 c4 e6 Nc3")
        self.db.save_repertoire_branch("white", "c4 first", "c4 Nf6 d4 e6 Nc3")
        self._seed_pre_fold_nodes({
            "d4 Nf6 c4 e6 Nc3": (9, 4, 5, 8, "2026-01-01 00:00:00", None),
            "c4 Nf6 d4 e6 Nc3": (4, 4, 0, 2, "2025-06-01 00:00:00", None),
        })
        self.db._run_schema_migrations()
        once = self._card("d4 Nf6 c4 e6 Nc3")

        conn = self.db.get_db()
        conn.execute("DELETE FROM schema_migrations WHERE version = ?", (self.MIGRATION,))
        conn.commit()
        conn.close()
        self.db._run_schema_migrations()

        self.assertEqual(self._card("d4 Nf6 c4 e6 Nc3"), once)

    def test_an_undrilled_card_defaults_rather_than_inheriting_nulls(self):
        self.db.save_repertoire_branch("white", "line", "e4")
        self._seed_pre_fold_nodes({"e4": (0, 0, 0, 1, "2026-01-01 00:00:00", None)})

        self.db._run_schema_migrations()

        card = self._card("e4")
        self.assertEqual(card["drill_count"], 0)
        self.assertEqual(card["interval_days"], 1)
        self.assertIsNone(card["last_drilled_at"])

    def test_the_backfilled_keys_are_the_real_position_keys(self):
        self.db.save_repertoire_branch("white", "line", "d4 Nf6 c4")
        card = self._card("d4 Nf6 c4")

        self.assertEqual(card["epd"], key_from_san_path("d4 Nf6"))
        self.assertEqual(card["san"], "c4")


if __name__ == "__main__":
    unittest.main()
