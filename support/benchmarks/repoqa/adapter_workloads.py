"""Prepare fixed, line-numbered public RepoQA workloads for repo-cache-bench."""

import argparse
import json
from pathlib import Path

from benchmark import gold, repos, write_jsonl

CASES = {'psf/black': 0, 'tokio-rs/tracing': 1, 'junegunn/fzf': 0}


def excerpt(files, path, start=1, end=None):
    lines = files[path].splitlines()[start - 1:end]
    body = '\n'.join(f'{index}: {line}' for index, line in enumerate(lines, start))
    return f'File {path}\n{body}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--retrieval', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True)
    rows = {(row['repo'], row['needle']): row for line in args.retrieval.read_text().splitlines()
            if (row := json.loads(line))['track'] == 'description' and row['engine'] == 'byok-rust'}
    with (args.out / 'workloads.jsonl').open('x') as output:
        for repo in repos(args.dataset, args.out / 'public-source'):
            name = repo['repo']
            if name not in CASES:
                continue
            needle = repo['needles'][CASES[name]]
            row = rows[name, CASES[name]]
            if row['commit'] != repo['commit_sha']:
                raise ValueError(f'{name}: retrieval and dataset commits differ')
            path, line, _ = gold(repo, needle)
            files = repo['content']
            ranked = list(dict.fromkeys([hit[0] for hit in row['hits'] if hit[0] != path] + [path]))
            documents = [excerpt(files, candidate) for candidate in ranked[:2]]
            documents.append(excerpt(files, path, max(1, line - 90), line + 300))
            source = '\n\n'.join(documents)
            if len(source) >= 260_000:
                raise ValueError(f'{name}: the definition excerpt might be outside the benchmark budget')
            for candidate in sorted(files.keys() - set(ranked)):
                if len(source) >= 220_000:
                    break
                source += '\n\n' + excerpt(files, candidate)
            if len(source) < 90_000:
                raise ValueError(f'{name}: not enough public source for a long-session benchmark')
            write_jsonl(output, {'repo': name, 'query': needle['description'].strip(), 'sources': source[:260_000],
                                 'expected_path': path, 'expected_line': line})


if __name__ == '__main__':
    main()
