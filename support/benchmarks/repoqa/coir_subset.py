# /// script
# requires-python = ">=3.10"
# dependencies = ["pyarrow==26.0.1"]
# ///
"""Run fixed-label code search on local CoIR Parquet exports, with no model calls."""

import argparse
import hashlib
import json
import statistics
import subprocess
from collections import defaultdict
from pathlib import Path

from benchmark import write_jsonl


def sample(ids, count):
    return sorted(ids, key=lambda value: hashlib.sha256(value.encode()).digest())[:count]


def main():
    import pyarrow.parquet as parquet  # pyright: ignore[reportMissingImports]  # Installed by uv for this script.

    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('queries', 'corpus', 'qrels', 'rust-query', 'model-dir', 'out'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--language', choices=('py', 'php', 'rb'), required=True)
    parser.add_argument('--reverse-qrels', action='store_true', help='For CoIR exports whose original direction is code to text')
    parser.add_argument('--limit', type=int, default=200)
    parser.add_argument('--distractors', type=int, default=2000)
    args = parser.parse_args()
    if args.limit <= 0 or args.distractors < 0:
        parser.error('query budget must be positive and distractor budget nonnegative')
    labels = defaultdict(set)
    query_key, document_key = ('corpus-id', 'query-id') if args.reverse_qrels else ('query-id', 'corpus-id')
    for row in parquet.read_table(args.qrels).to_pylist():
        if float(row['score']) > 0:
            labels[str(row[query_key])].add(str(row[document_key]))
    selected = sample(labels, args.limit)
    queries = {str(r['_id']): r['text'] for r in parquet.read_table(args.queries, columns=['_id', 'text']).to_pylist()}
    positives = set().union(*(labels[q] for q in selected))
    out = args.out.resolve()
    out.mkdir(parents=True)
    corpus = {str(r['_id']): r['text'] for r in parquet.read_table(args.corpus, columns=['_id', 'text']).to_pylist()}
    chosen = positives.union(sample(corpus.keys() - positives, args.distractors))
    ids = {doc: f'{hashlib.sha256(doc.encode()).hexdigest()[:24]}.{args.language}' for doc in chosen}
    root = out / 'snippets'
    root.mkdir()
    for doc, name in ids.items():
        (root / name).write_text(corpus[doc], encoding='utf8')
    cache = out / 'index'
    (cache / 'models').mkdir(parents=True)
    (cache / 'models' / 'potion-code-16M-v2').symlink_to(args.model_dir.resolve(), target_is_directory=True)
    rows = []
    with subprocess.Popen([str(args.rust_query.resolve()), str(cache), str(root)],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as worker, \
            (out / 'retrieval.jsonl').open('x') as output:
        assert worker.stdin and worker.stdout
        indexes = json.loads(worker.stdout.readline())
        for query_id in selected:
            write_jsonl(worker.stdin, {'root': str(root), 'query': queries[query_id]})
            reply = json.loads(worker.stdout.readline())
            expected = {ids[doc] for doc in labels[query_id]}
            rank = next((i for i, hit in enumerate(reply['hits'], 1) if hit[0] in expected), None)
            row = {'query_id': query_id, 'rank': rank, 'ms': reply['ms']}
            rows.append(row)
            write_jsonl(output, row)
        worker.stdin.close()
        if worker.wait():
            raise RuntimeError('Rust retrieval worker failed')
    result = {'language': args.language, 'queries': len(rows), 'documents': len(ids),
              'hit_at_1': sum(r['rank'] == 1 for r in rows),
              'hit_at_5': sum(r['rank'] is not None and r['rank'] <= 5 for r in rows),
              'hit_at_10': sum(r['rank'] is not None for r in rows),
              'p50_ms': statistics.median(r['ms'] for r in rows), 'cold_index_ms': indexes[0]['ms'],
              'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in (args.qrels, args.queries, args.corpus)}}
    (out / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
