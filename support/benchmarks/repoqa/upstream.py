"""Exposes upstream Semble's published Python index and search APIs as JSON Lines."""

import json
import os
import sys
import time
from pathlib import Path

from semble import SembleIndex
from semble.cache import save_index_to_cache
from semble.index.dense import load_model


def main():
    model_path, cache, *roots = sys.argv[1:]
    os.environ['SEMBLE_CACHE_LOCATION'] = cache
    os.environ['SEMBLE_INDEX_WORKERS'] = '4'
    load_model(model_path)
    indexes = {}
    stats = []
    for root in roots:
        started = time.perf_counter()
        index = SembleIndex.from_path(Path(root), model_path=model_path)
        save_index_to_cache(index, root)
        indexes[root] = index
        stats.append({'root': root, 'ms': (time.perf_counter() - started) * 1000,
                      'files': index.stats.indexed_files, 'chunks': index.stats.total_chunks})
    print(json.dumps(stats), flush=True)
    for line in sys.stdin:
        req = json.loads(line)
        started = time.perf_counter()
        results = indexes[req['root']].search(req['query'], top_k=10, max_snippet_lines=0)
        elapsed_ms = (time.perf_counter() - started) * 1000
        print(json.dumps({'ms': elapsed_ms, 'hits': [[str(r.chunk.file_path), r.chunk.start_line,
                                                     r.chunk.end_line] for r in results]}), flush=True)


if __name__ == '__main__':
    main()
