#!/usr/bin/env python3
"""Verify paired retrieval results and score the ranked lists in raw.gz."""

import gzip
import json
from collections import defaultdict
from pathlib import Path

CUTOFFS = (1, 5, 10)
IDENTITY_FIELDS = ("repo", "track", "id")


def first_hit(gold, hits):
    gold_path, gold_line = gold
    return next(
        (
            rank
            for rank, (path, start, end) in enumerate(hits, start=1)
            if path == gold_path and start <= gold_line <= end
        ),
        None,
    )


def load_and_verify(path):
    suites = defaultdict(lambda: defaultdict(dict))
    with gzip.open(path, "rt", encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            row = json.loads(line)
            identity = tuple(row[field] for field in IDENTITY_FIELDS)
            suite, arm = row["suite"], row["arm"]
            records = suites[suite][arm]
            if identity in records:
                raise ValueError(
                    f"Duplicate query at input line {line_number} in {suite}/{arm}: "
                    f"{identity!r}"
                )
            records[identity] = row

    if not suites:
        raise ValueError("No suites in input")
    for suite, arms in sorted(suites.items()):
        if not {"A", "B"} <= arms.keys():
            raise ValueError(f"Missing A or B in {suite}")
        baseline = arms["A"]
        for arm, records in sorted(arms.items()):
            if arm == "A":
                continue
            if baseline.keys() != records.keys():
                missing = sorted(baseline.keys() - records.keys())
                extra = sorted(records.keys() - baseline.keys())
                raise ValueError(
                    f"Query identities differ in {suite}/A and {suite}/{arm}: "
                    f"missing {missing!r}, extra {extra!r}"
                )
            for identity, row in sorted(baseline.items()):
                for field in ("query", "gold"):
                    if row[field] != records[identity][field]:
                        raise ValueError(
                            f"{field} differs in {suite}/A and {suite}/{arm}: {identity!r}"
                        )
    return suites


def summarize(ranks_by_arm, identities):
    counts = {}
    for arm, ranks in sorted(ranks_by_arm.items()):
        selected_ranks = [ranks[identity] for identity in identities]
        counts[arm] = {"queries": len(selected_ranks)}
        for cutoff in CUTOFFS:
            counts[arm][f"top{cutoff}"] = sum(
                rank is not None and rank <= cutoff for rank in selected_ranks
            )

    a_hits, b_hits = (
        {
            identity
            for identity in identities
            if ranks_by_arm[arm][identity] is not None
            and ranks_by_arm[arm][identity] <= 10
        }
        for arm in ("A", "B")
    )
    gains = sorted(b_hits - a_hits)
    losses = sorted(a_hits - b_hits)
    return {
        "arms": counts,
        "A_to_B_at_10": {
            "gains": len(gains),
            "losses": len(losses),
            "gained_queries": [dict(zip(IDENTITY_FIELDS, identity)) for identity in gains],
            "lost_queries": [dict(zip(IDENTITY_FIELDS, identity)) for identity in losses],
        },
    }


def score(suites):
    report = {}
    for suite, arms in sorted(suites.items()):
        ranks_by_arm = {
            arm: {
                identity: first_hit(row["gold"], row["hits"])
                for identity, row in records.items()
            }
            for arm, records in arms.items()
        }
        identities_by_track = defaultdict(list)
        for identity in sorted(arms["A"]):
            identities_by_track[identity[1]].append(identity)
        report[suite] = {
            "combined": summarize(ranks_by_arm, sorted(arms["A"])),
            "tracks": {
                track: summarize(ranks_by_arm, identities)
                for track, identities in sorted(identities_by_track.items())
            },
        }
    return report


def main():
    directory = Path(__file__).resolve().parent
    suites = load_and_verify(directory / "code-scores.jsonl.gz")
    report = score(suites)
    output = directory / "verified.json"
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
