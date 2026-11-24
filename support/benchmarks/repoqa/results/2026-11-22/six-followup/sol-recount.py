import gzip
import json
from collections import Counter, defaultdict
from pathlib import Path
from statistics import fmean, pvariance

DIRECTORY = Path(__file__).resolve().parent
CUTOFFS = (1, 5, 10)
STAGES = ("dense", "bm25", "rerank")


def read_jsonl(stream):
    return (json.loads(line) for line in stream if line.strip())


def first_rank(hits, path, line):
    return next(
        (rank for rank, (hit_path, start, end) in enumerate(hits, 1)
         if hit_path == path and start <= line <= end),
        None,
    )


def summarize_query(label, repetitions):
    ranks = [rank for _, rank in repetitions]
    observed_ranks = [rank for rank in ranks if rank is not None]
    counts = Counter(ranks)
    top = {}
    for k in CUTOFFS:
        indicators = [int(rank is not None and rank <= k) for rank in ranks]
        top[f"top{k}"] = {
            "measurement_hits": sum(indicators),
            "hit_rate": fmean(indicators),
            "hit_population_variance": pvariance(indicators),
        }
    return {
        "difficulty": label["difficulty"],
        "measurements": len(repetitions),
        "rank_counts": [{"rank": rank, "measurements": count} for rank, count in counts.items()],
        "hit_rank_population_variance": pvariance(observed_ranks) if observed_ranks else None,
        "distinct_top_k_lists": len({tuple(map(tuple, row["hits"])) for row, _ in repetitions}),
        "latency_ms_population_variance": pvariance([row["ms"] for row, _ in repetitions]),
        **top,
    }


def aggregate(queries):
    result = {
        "questions": len(queries),
        "measurements": sum(query["measurements"] for query in queries),
    }
    for k in CUTOFFS:
        metric = f"top{k}"
        stats = [query[metric] for query in queries]
        result[metric] = {
            "question_weighted_hit_rate": fmean(stat["hit_rate"] for stat in stats),
            "question_equivalent_hits": sum(stat["hit_rate"] for stat in stats),
            "measurement_hits": sum(stat["measurement_hits"] for stat in stats),
        }
    return result


def diagnose_stage(trace, label, groups):
    question = label["id"]
    path, line = label["path"], label["line"]
    top_hits = trace["top10"]
    if trace["gold"] != [path, line] or first_rank(top_hits, path, line) is not None:
        raise ValueError(f"Stage snapshot for {question} does not describe a labeled miss")
    same_file = trace["same_file_at_each_stage"]
    evidence = {
        stage: [
            {"position": entry["rank"], "lines": entry["lines"],
             "covers_label": entry["lines"][0] <= line <= entry["lines"][1]}
            for entry in same_file.get(stage, [])
        ]
        for stage in STAGES
    }
    final_same_file = [
        {"position": rank, "lines": [start, end]}
        for rank, (hit_path, start, end) in enumerate(top_hits, 1)
        if hit_path == path
    ]
    matches = {
        variant: sum(row["hits"] == top_hits for row, _ in queries[question])
        for variant, queries in groups.items()
    }
    return {
        "id": question,
        "difficulty": label["difficulty"],
        "symbol": label["symbol"],
        "label": {"path": path, "line": line},
        "matching_top_k_measurements_by_variant": matches,
        "same_file_stage_evidence": evidence,
        "same_file_final_top_k": final_same_file,
    }


def describe_miss(miss):
    details = []
    for stage, candidates in miss["same_file_stage_evidence"].items():
        covering = [str(candidate["position"]) for candidate in candidates if candidate["covers_label"]]
        if covering:
            details.append(f"{stage} covers the line at #{', #'.join(covering)}")
        elif candidates:
            nearest = min(candidates, key=lambda candidate: min(
                abs(miss["label"]["line"] - endpoint) for endpoint in candidate["lines"]
            ))
            start, end = nearest["lines"]
            details.append(f"{stage} closest recorded span {start}–{end} at #{nearest['position']}")
    spans = miss["same_file_final_top_k"]
    if spans:
        details.extend(f"final #{span['position']} has lines {span['lines'][0]}–{span['lines'][1]}"
                       for span in spans)
    else:
        if not details:
            details.append("no same-file candidates recorded in dense, BM25 or rerank")
        details.append("target file absent from final top 10")
    return f"{miss['id']} (line {miss['label']['line']}) — " + ", ".join(details)


def main():
    with (DIRECTORY.parent / "search-proof" / "queries.jsonl").open(encoding="utf-8") as source:
        label_rows = list(read_jsonl(source))
    labels = {label["id"]: label for label in label_rows}
    if len(labels) != len(label_rows):
        raise ValueError("Duplicate question IDs in labels.jsonl")

    groups = defaultdict(lambda: defaultdict(list))
    discrepancies = []
    seen_samples = set()
    warmup = 0
    with gzip.open(DIRECTORY.parent / "search-proof" / "final-samples.jsonl.gz", "rt", encoding="utf-8") as source:
        for row in read_jsonl(source):
            if row["phase"] == "warmup":
                warmup += 1
                continue
            if row["phase"] != "measure":
                raise ValueError(f"Unexpected phase {row['phase']!r}")
            question, variant, sample = row["id"], row["variant"], row["sample"]
            label = labels[question]
            if sample in seen_samples or row["repo"] != label["repo"] or len(row["hits"]) != max(CUTOFFS):
                raise ValueError(f"Duplicate sample, repository mismatch, or unexpected hit count in sample {sample}")
            seen_samples.add(sample)
            rank = first_rank(row["hits"], label["path"], label["line"])
            groups[variant][question].append((row, rank))
            if rank != row["rank"]:
                discrepancies.append({"sample": sample, "round": row["round"], "id": question,
                                      "variant": variant, "computed_rank": rank, "supplied_rank": row["rank"]})

    difficulty_levels = sorted({label["difficulty"] for label in labels.values()})
    variants = {}
    for variant, questions in sorted(groups.items()):
        if questions.keys() != labels.keys():
            raise ValueError(f"Missing questions for variant {variant}")
        per_query = {question: summarize_query(labels[question], repetitions)
                     for question, repetitions in sorted(questions.items())}
        queries = list(per_query.values())
        variants[variant] = {
            "overall": aggregate(queries),
            "by_difficulty": {
                level: aggregate([query for query in queries if query["difficulty"] == level])
                for level in difficulty_levels
            },
            "per_query": per_query,
            "queries_with_rank_variation": [question for question, query in per_query.items()
                                            if len(query["rank_counts"]) > 1],
            "queries_with_top_k_list_variation": [question for question, query in per_query.items()
                                                  if query["distinct_top_k_lists"] > 1],
        }

    with (DIRECTORY / "stages.json").open(encoding="utf-8") as source:
        misses = [diagnose_stage(trace, labels[trace["id"]], groups) for trace in json.load(source)]
    limits = [
        "Stage snapshots show recorded same-file candidates. Missing spans could reflect index or chunk coverage, or retrieval beyond the recorded candidate windows.",
        "The traces do not establish why a candidate ranked where it did, how rerank positions became final output positions, or what changing top_k would return.",
    ]
    result = {
        "top_k": max(CUTOFFS),
        "unique_questions": len(labels),
        "measured_repetitions": len(seen_samples),
        "warmup_rows_excluded": warmup,
        "scoring": "First exact path match with start <= labeled line <= end. Null rank means no hit in the returned list. Aggregate rates average within question and then across questions.",
        "variants": variants,
        "supplied_rank_discrepancy_count": len(discrepancies),
        "supplied_rank_discrepancies": discrepancies,
        "stage_misses": misses,
        "untraced_top_k_misses_by_variant": {
            variant: [
                question for question, query in stats["per_query"].items()
                if query[f"top{max(CUTOFFS)}"]["measurement_hits"] == 0
                and all(miss["id"] != question or not miss["matching_top_k_measurements_by_variant"][variant]
                        for miss in misses)
            ]
            for variant, stats in variants.items()
        },
        "stage_diagnostic_limits": limits,
    }
    with (DIRECTORY / "recount.json").open("w", encoding="utf-8") as destination:
        json.dump(result, destination, indent=2, ensure_ascii=False)
        destination.write("\n")

    repeat_counts = sorted({query["measurements"] for stats in variants.values()
                            for query in stats["per_query"].values()})
    print(f"{len(labels)} unique questions, {len(seen_samples)} measured rows, "
          f"{', '.join(map(str, repeat_counts))} repetitions per question/variant, {warmup} warmups excluded.")
    print(f"Supplied-rank discrepancies across all measured rows — {len(discrepancies)}")
    for discrepancy in discrepancies:
        print(json.dumps(discrepancy))
    print("Variant  Difficulty  Measurements  Top 1 / Top 5 / Top 10 (question-weighted)")
    for variant, stats in variants.items():
        for difficulty, summary in {"overall": stats["overall"], **stats["by_difficulty"]}.items():
            scores = " / ".join(
                f"{summary[f'top{k}']['question_equivalent_hits']:g}/{summary['questions']} "
                f"({summary[f'top{k}']['question_weighted_hit_rate']:.1%})" for k in CUTOFFS
            )
            print(f"{variant:<7}  {difficulty:<10}  {summary['measurements']:>12}  {scores}")
        print(f"{variant} rank variation — {stats['queries_with_rank_variation'] or 'none'}. "
              f"Ordered top-10 variation — {stats['queries_with_top_k_list_variation'] or 'none'}.")
    print("Fixed-top-10 stage diagnoses (per-variant exact output matches in parentheses)")
    for miss in misses:
        matches = ", ".join(f"{variant} {count}/{len(groups[variant][miss['id']])}"
                            for variant, count in miss["matching_top_k_measurements_by_variant"].items())
        print(f"{describe_miss(miss)} ({matches})")
    for variant, untraced in result["untraced_top_k_misses_by_variant"].items():
        print(f"{variant} top-10 misses without matching stage snapshots — {len(untraced)}")
    for limit in limits:
        print(limit)
    print("Per-query rank, hit indicator and latency variances are in recount.json.")


if __name__ == "__main__":
    main()
