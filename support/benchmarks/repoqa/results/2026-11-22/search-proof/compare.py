"""Alternate two real Rust search workers with frozen definition-line labels (macOS)."""
import argparse
import hashlib
import json
import platform
import statistics
import subprocess
import time
from collections import defaultdict
from contextlib import ExitStack
from math import ceil
from pathlib import Path
from select import select
from typing import Any

HERE = Path(__file__).resolve().parent
PROFILE = '(version 1) (allow default) (deny network*) (deny file-write*)'
VARIANTS = ('A', 'B')
WARMUP = (
    'Locate package initialization and version constants.',
    'Which test helper constructs a component for a renderer integration test?',
    'Where are host configuration flags read during module initialization?',
    'Which source file defines unit tests for browser event dispatch?',
)


def digest(path):
    sha = hashlib.sha256()
    with path.open('rb') as src:
        for block in iter(lambda: src.read(1024 * 1024), b''):
            sha.update(block)
    return sha.hexdigest()


def cache_manifest(cache):
    files = sorted((cache / 'indexes').rglob('*.bin'))
    files.extend(sorted((cache / 'models/potion-code-16M-v2').glob('*')))
    return {
        str(path.relative_to(cache)): {'bytes': path.stat().st_size, 'sha256': digest(path)}
        for path in files if path.is_file()
    }


def hit_rank(row, hits):
    return next((rank for rank, (path, start, end) in enumerate(hits, 1)
                 if path == row['path'] and start <= row['line'] <= end), None)


def metrics(rows):
    latencies = sorted(row['ms'] for row in rows)
    ranks_by_question = defaultdict(list)
    for row in rows:
        ranks_by_question[row['id']].append(row['rank'])
    return {
        'questions': len(ranks_by_question),
        'timed_samples': len(rows),
        'questions_hit_on_every_run': {k: sum(all(rank is not None and rank <= k for rank in ranks)
                                              for ranks in ranks_by_question.values())
                                      for k in (1, 5, 10)},
        'p50_ms': statistics.median(latencies),
        'p95_ms': latencies[ceil(0.95 * len(latencies)) - 1],
    }


def dump_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

class Worker:
    def __init__(self, command, out, variant, stack):
        self.stdin_log = stack.enter_context((out / f'{variant}.stdin.jsonl').open('wb'))
        self.stdout_log = stack.enter_context((out / f'{variant}.stdout.jsonl').open('wb'))
        stderr = stack.enter_context((out / f'{variant}.stderr').open('wb'))
        self.proc = subprocess.Popen(command, cwd=HERE, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=stderr)
        stack.callback(self.stop)
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.stdin, self.stdout = self.proc.stdin, self.proc.stdout
        self.prepare = self.read()

    def read(self):
        if not select([self.stdout], [], [], 20)[0]:
            raise TimeoutError('worker did not respond within 20 seconds')
        raw = self.stdout.readline()
        if not raw:
            raise RuntimeError(f'worker closed stdout; exit status: {self.proc.poll()}')
        self.stdout_log.write(raw)
        return json.loads(raw)

    def search(self, payload):
        self.stdin_log.write(payload)
        self.stdin.write(payload)
        self.stdin.flush()
        return self.read()

    def finish(self):
        self.stdin.close()
        status = self.proc.wait(timeout=10)
        if status != 0:
            raise subprocess.CalledProcessError(status, self.proc.args)

    def stop(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        if self.proc.stdin:
            self.proc.stdin.close()
        if self.proc.stdout:
            self.proc.stdout.close()


def encode(root, query):
    return (json.dumps({'root': str(root), 'query': query}) + '\n').encode()


def comparison(rows, measured):
    per_query = []
    for row in rows:
        qid = row['id']
        by_variant = {variant: measured[variant][qid] for variant in VARIANTS}
        different = {variant: len({tuple(map(tuple, trial['hits'])) for trial in trials})
                     for variant, trials in by_variant.items()}
        first = {variant: trials[0]['hits'] for variant, trials in by_variant.items()}
        old, new = (set(map(tuple, first[variant])) for variant in VARIANTS)
        per_query.append({'id': qid, 'repo': row['repo'], 'unique_ordered_lists': different,
                          'top10_order_changed': first['A'] != first['B'],
                          'top1_changed': first['A'][:1] != first['B'][:1],
                          'removed_chunks': sorted(old - new), 'added_chunks': sorted(new - old),
                          'first_rank': {variant: hit_rank(row, hits) for variant, hits in first.items()},
                          'rank_by_trial': {variant: [trial['rank'] for trial in trials]
                                            for variant, trials in by_variant.items()}})
    return per_query


def summarize(rows, measured, delta):
    result = {}
    for repo in dict.fromkeys(row['repo'] for row in rows):
        queries = [row for row in delta if row['repo'] == repo]
        variants = {}
        for variant in VARIANTS:
            trials = [trial for q in queries for trial in measured[variant][q['id']]]
            variants[variant] = metrics(trials)
            variants[variant]['stable_ordered_queries'] = sum(
                q['unique_ordered_lists'][variant] == 1 for q in queries
            )
        result[repo] = {'queries': len(queries), 'variants': variants,
                        'changed_top1_queries': sum(q['top1_changed'] for q in queries),
                        'changed_top10_ordered_queries': sum(q['top10_order_changed'] for q in queries),
                        'changed_top10_set_queries': sum(bool(q['removed_chunks'] or q['added_chunks'])
                                                         for q in queries),
                        'removed_query_chunk_pairs': sum(len(q['removed_chunks']) for q in queries),
                        'added_query_chunk_pairs': sum(len(q['added_chunks']) for q in queries)}
    return result


def main():
    parser = argparse.ArgumentParser()
    for name in ('repos', 'baseline', 'baseline-cache', 'candidate', 'candidate-cache', 'out'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    labels = HERE / 'queries.jsonl'
    query_hash = digest(labels)
    if query_hash != (HERE / 'queries.sha256').read_text().split()[0]:
        raise ValueError('frozen label SHA-256 mismatch')
    rows = [json.loads(line) for line in labels.read_text().splitlines()]
    roots = {repo: (args.repos / repo).resolve(strict=True) for repo in dict.fromkeys(r['repo'] for r in rows)}
    inputs = {
        'A': (args.baseline.resolve(strict=True), args.baseline_cache.resolve(strict=True)),
        'B': (args.candidate.resolve(strict=True), args.candidate_cache.resolve(strict=True)),
    }
    commands = {}
    meta: dict[str, Any] = {'host': platform.platform(), 'queries_sha256': query_hash, 'variants': {}}
    for variant, (binary, cache) in inputs.items():
        commands[variant] = ['/usr/bin/sandbox-exec', '-p', PROFILE, str(binary), str(cache),
                             *map(str, roots.values())]
        meta['variants'][variant] = {'command': commands[variant], 'sha256': digest(binary),
                                     'cache_inputs': cache_manifest(cache)}
    for row in rows:
        path = roots[row['repo']] / row['path']
        if (digest(path) != row['source_sha256']
                or path.read_text().splitlines()[row['line'] - 1].strip() != row['declaration']):
            raise ValueError(f"frozen source or declaration changed: {row['id']}")
    out.mkdir(parents=True, exist_ok=False)
    dump_json(out / 'run.json', meta)
    measured: dict[str, dict[str, list[dict[str, Any]]]] = {v: defaultdict(list) for v in VARIANTS}
    number = 0
    with ExitStack() as stack:
        workers = {v: Worker(commands[v], out, v, stack) for v in VARIANTS}
        raw = stack.enter_context((out / 'samples.jsonl').open('w'))
        for variant, worker in workers.items():
            init = worker.prepare
            if [entry['root'] for entry in init] != list(map(str, roots.values())):
                raise ValueError(f'{variant} did not prepare the expected roots')
            meta['variants'][variant]['prepare'] = init
        for root in roots.values():
            for query, order in zip(WARMUP, ('AB', 'BA', 'AB', 'BA')):
                for variant in order:
                    response = workers[variant].search(encode(root, query))
                    raw.write(json.dumps({'phase': 'warmup', 'variant': variant, 'root': str(root),
                                          'query': query, 'response': response}) + '\n')
        start = time.perf_counter()
        meta['start_unix_ns'] = time.time_ns()
        for round_no in range(4):
            order_rows = rows if round_no % 2 == 0 else rows[::-1]
            for row in order_rows:
                order = 'ABBA' if round_no % 2 == 0 else 'BAAB'
                payload = encode(roots[row['repo']], row['query'])
                for variant in order:
                    number += 1
                    response = workers[variant].search(payload)
                    hits = response['hits']
                    if len(hits) > 10:
                        raise ValueError(f"expected top-10 results, got {len(hits)} for {row['id']}")
                    sample = {'phase': 'measure', 'sample': number, 'round': round_no + 1,
                              'block_order': order, 'variant': variant, 'id': row['id'],
                              'repo': row['repo'], 'rank': hit_rank(row, hits), **response}
                    measured[variant][row['id']].append(sample)
                    raw.write(json.dumps(sample) + '\n')
        meta['end_unix_ns'] = time.time_ns()
        meta['measurement_wall_ms'] = (time.perf_counter() - start) * 1000
        for worker in workers.values():
            worker.finish()
    if any(len(measured[v][row['id']]) != 8 for row in rows for v in VARIANTS):
        raise ValueError('expected eight measured responses per query and worker')
    if digest(labels) != query_hash or any(
        digest(binary) != meta['variants'][variant]['sha256']
        or cache_manifest(cache) != meta['variants'][variant]['cache_inputs']
        for variant, (binary, cache) in inputs.items()
    ):
        raise ValueError('frozen labels, binaries, or cache contents changed during measurement')
    dump_json(out / 'run.json', meta)
    delta = comparison(rows, measured)
    dump_json(out / 'comparison.json', delta)
    summary = summarize(rows, measured, delta)
    dump_json(out / 'summary.json', summary)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
