"""Measure complementary coverage and a fixed-budget merge of two real retrieval runs."""

import argparse
import json
from pathlib import Path

from benchmark import covers


def load(path, engine):
    return {(row['repo'], row['commit'], row['track'], row['needle']): row
            for line in path.read_text().splitlines()
            if (row := json.loads(line)).get('engine') == engine}


def interleave(left, right):
    result = []
    for rank in range(max(len(left), len(right))):
        for source in (left, right):
            if rank < len(source) and source[rank] not in result:
                result.append(source[rank])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rust', type=Path, required=True)
    parser.add_argument('--mcp', type=Path, required=True)
    args = parser.parse_args()
    rust, mcp = load(args.rust, 'byok-rust'), load(args.mcp, None)
    if not rust or rust.keys() != mcp.keys():
        raise ValueError('Runs must cover the same pinned repository commits and queries')
    for track in ('description', 'symbol'):
        arms = {key: 0 for key in ('rust_top1', 'mcp_top1', 'rust_top5', 'mcp_top5', 'merged_top5',
                                    'rust_top10', 'mcp_top10', 'merged_top10', 'union_top10', 'rust_only', 'mcp_only')}
        queries = 0
        for case, row in rust.items():
            if case[2] != track:
                continue
            queries += 1
            other = mcp[case]
            if row['gold'] != other['gold']:
                raise ValueError(f'Gold definition differs for {case}')
            targets = row['gold']
            left, right = row['hits'], other['hits']
            merged = interleave(left, right)
            for label, hits in [('rust', left), ('mcp', right), ('merged', merged)]:
                for k in (1, 5, 10) if label != 'merged' else (5, 10):
                    arms[f'{label}_top{k}'] += any(covers(hit, targets) for hit in hits[:k])
            left_found = any(covers(hit, targets) for hit in left[:10])
            right_found = any(covers(hit, targets) for hit in right[:10])
            arms['union_top10'] += left_found or right_found
            arms['rust_only'] += left_found and not right_found
            arms['mcp_only'] += right_found and not left_found
        print(json.dumps({'track': track, 'queries': queries, **arms}))


if __name__ == '__main__':
    main()
