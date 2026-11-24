"""Compare primary, secondary and source-diversity-gated search on the same live lists."""

import argparse
import csv
import hashlib
import json
import math
import random
import statistics
import time
import urllib.error
import urllib.parse
from pathlib import Path

from benchmark import SWE, payload, send, write_jsonl
from web import FRAMES_SHA256, Exa, evidence, federation, wiki_title


def authority(url):
    return (urllib.parse.urlsplit(url).hostname or '').removeprefix('www.')


def fuse(primary, secondary):
    scores = {}
    values = {}
    for listing in (primary, secondary):
        seen = set()
        for rank, hit in enumerate(listing[:10], 1):
            key = ('wiki', wiki_title(hit[0])) if wiki_title(hit[0]) else ('url', hit[0])
            if key not in seen:
                seen.add(key)
                values.setdefault(key, hit)
                scores[key] = scores.get(key, 0) + 1 / (60 + rank)
    return [values[key] for key in sorted(scores, key=scores.__getitem__, reverse=True)[:10]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ('dataset', 'worker', 'out'):
        parser.add_argument('--' + arg, type=Path, required=True)
    parser.add_argument('--start', type=int, default=12)
    parser.add_argument('--count', type=int, default=12)
    args = parser.parse_args()
    if hashlib.sha256(args.dataset.read_bytes()).hexdigest() != FRAMES_SHA256:
        raise ValueError('unexpected public dataset digest')
    with args.dataset.open() as file:
        cases = list(csv.DictReader(file, delimiter='\t'))[args.start:args.start + args.count]
    if not cases or len(cases) != args.count:
        raise ValueError('invalid requested slice')
    args.out.mkdir(parents=True)
    with (args.out / 'queries.jsonl').open('x') as frozen:
        for case in cases:
            body = payload('messages', SWE, '', 'Return one concise standalone search query for finding evidence for the question. Output the query alone.', [{'role': 'user', 'content': case['Prompt']}])
            answer = send('http://127.0.0.1:3425/v1', 'messages', body, SWE)
            query = answer.get('answer', '').strip('" ')
            if not query or '\n' in query:
                raise ValueError(f'invalid search query for row {case[""]}')
            write_jsonl(frozen, {'id': case[''], 'query': query})
    queries = [json.loads(line)['query'] for line in (args.out / 'queries.jsonl').read_text().splitlines()]
    rows = []
    with federation(args.worker) as primary, (args.out / 'responses.jsonl').open('x') as raw:
        secondary = Exa()
        for i, (case, query) in enumerate(zip(cases, queries)):
            calls = [('primary', primary), ('secondary', secondary.search)]
            result = {}
            for arm, search in (calls if i % 2 == 0 else reversed(calls)):
                start = time.monotonic()
                try:
                    result[arm] = search(query, 10)
                except (urllib.error.URLError, TimeoutError) as error:
                    result[arm] = {'error': str(error), 'seconds': time.monotonic() - start}
            write_jsonl(raw, {'id': case[''], 'query': query, **result})
            gold = {title for key, url in case.items() if key.startswith('wikipedia_link_') and url and (title := wiki_title(url))}
            left, right = (result[arm].get('hits', [])[:10] for arm in ('primary', 'secondary'))
            collapsed = len({authority(url) for url, _ in left}) <= 1
            both = fuse(left, right)
            variants = {'primary': left, 'secondary': right, 'fusion': both, 'gated': both if collapsed else left}
            matched = {name: sorted(evidence(hits) & gold) for name, hits in variants.items()}
            rows.append({'id': case[''], 'gold': sorted(gold), 'matched': matched, 'collapsed': collapsed,
                         'errors': {name: x['error'] for name, x in result.items() if 'error' in x},
                         'seconds': {name: x['seconds'] for name, x in result.items()}})
    total = sum(len(r['gold']) for r in rows)
    report = {'rows': rows, 'expected': total, 'gated_extra_calls': sum(r['collapsed'] for r in rows),
              'latency_seconds': {arm: {'p50': statistics.median(r['seconds'][arm] for r in rows),
                                        'p95': sorted(r['seconds'][arm] for r in rows)[math.ceil(.95 * len(rows)) - 1]}
                                  for arm in ('primary', 'secondary')}, 'arms': {}}
    for name in ('primary', 'secondary', 'fusion', 'gated'):
        diffs = [(len(r['matched'][name]) - len(r['matched']['primary'])) / len(r['gold']) for r in rows]
        rng = random.Random(431)
        boot = sorted(statistics.mean(rng.choices(diffs, k=len(diffs))) for _ in range(10000))
        report['arms'][name] = {'hits': sum(len(r['matched'][name]) for r in rows),
                                'gained_queries': sum(d > 0 for d in diffs), 'lost_queries': sum(d < 0 for d in diffs),
                                'paired_mean_recall_delta_ci95': [boot[249], boot[9749]]}
    (args.out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'rows'}))


if __name__ == '__main__':
    main()
