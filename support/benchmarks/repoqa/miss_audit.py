"""Separate missing index coverage from missed ranking on paired RepoQA runs."""

import argparse
import collections
import json
import subprocess
from pathlib import Path

from benchmark import covers, write_jsonl
from hybrid_retrieval import load


def miss_stage(reply, target):
    if not reply['file_indexed']:
        return 'file_not_indexed', None
    if not reply['covering_chunks']:
        return 'definition_line_not_chunked', None
    rank = next((i for i, hit in enumerate(reply['hits'], 1) if covers(hit, target)), None)
    if rank is None:
        return 'not_in_expanded_top_100', None
    if rank <= 10:
        return 'recovers_when_candidate_budget_expands', rank
    return 'ranked_below_top_10', rank


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rust-run', type=Path, required=True)
    parser.add_argument('--mcp-run', type=Path, required=True)
    parser.add_argument('--rust-query', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    rust_run = args.rust_run.resolve()
    rust = load(rust_run / 'retrieval.jsonl', 'byok-rust')
    mcp = load(args.mcp_run / 'retrieval.jsonl', None)
    if not rust or rust.keys() != mcp.keys():
        raise ValueError('Both runs must cover the same pinned revisions, tracks and questions')
    rows = []
    for key, row in rust.items():
        if row['gold'] != mcp[key]['gold']:
            raise ValueError(f'Gold definition differs for {key}')
        if row['track'] == 'description' and row['rank'] is None and mcp[key]['rank'] is None:
            rows.append(row)
    args.out.mkdir(parents=True)
    roots = {row['repo']: rust_run / 'corpus' / row['repo'] for row in rows}
    counts = collections.Counter()
    with subprocess.Popen([str(args.rust_query.resolve()), str(rust_run / 'rust-index'),
                           *map(str, roots.values())], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          text=True) as worker, (args.out / 'misses.jsonl').open('x') as out:
        assert worker.stdin and worker.stdout
        json.loads(worker.stdout.readline())
        for row in rows:
            path, line, symbol = row['gold']
            write_jsonl(worker.stdin, {'root': str(roots[row['repo']]), 'query': row['query'],
                                      'audit': {'path': path, 'line': line, 'symbol': symbol}})
            reply = json.loads(worker.stdout.readline())
            stage, rank = miss_stage(reply, row['gold'])
            counts[stage] += 1
            write_jsonl(out, {k: row[k] for k in ('repo', 'commit', 'needle', 'query', 'gold')} | {
                'stage': stage, 'expanded_rank': rank, 'file_indexed': reply['file_indexed'],
                'covering_chunks': reply['covering_chunks'], 'indexed_symbol': reply['indexed_symbol'],
                'first_rank_in_target_file': next((i for i, hit in enumerate(reply['hits'], 1) if hit[0] == path), None),
            })
        worker.stdin.close()
        if worker.wait():
            raise RuntimeError('Rust audit worker failed')
    print(json.dumps({'joint_misses': len(rows), 'stages': counts}))


if __name__ == '__main__':
    main()
