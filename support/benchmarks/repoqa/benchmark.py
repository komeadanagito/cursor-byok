"""Compare Semble implementations on pinned RepoQA cases and measure live provider cache usage."""

import argparse
import concurrent.futures
import gzip
import hashlib
import json
import os
import platform
import re
import statistics
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATASET = 'https://github.com/evalplus/repoqa_release/releases/download/2024-06-23/repoqa-2024-06-23.json.gz'
DATASET_SHA256 = 'c050a2ad90a7df89d9dc1f1c3b3b20683edd20a56293b35fcaae43dec115d681'
REPOSITORIES = ('psf/black', 'skypjack/uvw', 'square/retrofit', 'axios/axios', 'tokio-rs/tracing', 'junegunn/fzf')
SWE = 'devin/swe-2'
SOL = 'codex/gpt-6.2-sol'
ARMS = (('messages', SWE), ('chat/completions', SWE), ('responses', SWE), ('responses', SOL))


def gold(repo, needle):
    path, name = needle['path'], needle['name']
    source = repo['content'][path].encode()
    start, end = needle['start_byte'], needle['end_byte']
    match = re.search(rb'\b' + re.escape(name.encode()) + rb'\b', source[start:end])
    if not match:
        raise ValueError(f'gold symbol {name} missing in {path}:{start}-{end}')
    return path, source.count(b'\n', 0, start + match.start()) + 1, name


def covers(hit, expected):
    path, start, end = hit
    return path == expected[0] and start <= expected[1] <= end


def accepts(answer, hits, expected):
    try:
        obj = json.loads(answer)
    except json.JSONDecodeError:
        return False
    if not isinstance(obj, dict):
        return False
    idx, line = obj.get('candidate'), obj.get('line')
    return (type(idx) is int and 1 <= idx <= len(hits)
            and type(line) is int and line == expected[1] and covers(hits[idx - 1], expected))


def usage_counts(protocol, usage):
    if protocol == 'messages':
        read = usage.get('cache_read_input_tokens')
        write = usage.get('cache_creation_input_tokens')
        return usage['input_tokens'] + (read or 0) + (write or 0), read, write, usage['output_tokens']
    if protocol == 'chat/completions':
        details = usage.get('prompt_tokens_details') or {}
        return usage['prompt_tokens'], details.get('cached_tokens'), details.get('cache_write_tokens'), usage['completion_tokens']
    details = usage.get('input_tokens_details') or {}
    return usage['input_tokens'], details.get('cached_tokens'), details.get('cache_write_tokens'), usage['output_tokens']


def repos(dataset, corpus, repository_names=REPOSITORIES):
    raw = dataset.read_bytes()
    if hashlib.sha256(raw).hexdigest() != DATASET_SHA256:
        raise ValueError('RepoQA gzip does not match the pinned SHA-256')
    rows = json.loads(gzip.decompress(raw))
    selected = {row['repo']: dict(row, language=lang) for lang, entries in rows.items()
                for row in entries if row['repo'] in repository_names}
    for name in repository_names:
        repo = selected[name]
        root = corpus / name
        for path, contents in repo['content'].items():
            file = (root / path).resolve()
            file.relative_to(root)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(contents.encode())
        yield dict(repo, root=root)


def write_jsonl(file, row):
    file.write(json.dumps(row, ensure_ascii=False) + '\n')
    file.flush()


def retrieval(command, cache, corpus, output, engine):
    roots = [str(repo['root']) for repo in corpus]
    with subprocess.Popen([*command, str(cache), *roots], cwd=cache.parent,
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as worker:
        assert worker.stdin and worker.stdout
        ready = json.loads(worker.stdout.readline())
        first_cases = []
        for repo in corpus:
            for index, needle in enumerate(repo['needles']):
                expected = gold(repo, needle)
                for track, query in [('description', needle['description'].strip()), ('symbol', expected[2])]:
                    row = {'repo': repo['repo'], 'commit': repo['commit_sha'], 'needle': index,
                           'track': track, 'query': query, 'engine': engine, 'gold': expected}
                    write_jsonl(worker.stdin, {'root': str(repo['root']), 'query': query})
                    reply = json.loads(worker.stdout.readline())
                    hits = reply['hits']
                    row.update(reply, rank=next((i for i, hit in enumerate(hits, 1) if covers(hit, expected)), None))
                    write_jsonl(output, row)
                    if index == 0 and track == 'description':
                        first_cases.append((repo, row))
        worker.stdin.close()
        if worker.wait():
            raise RuntimeError(f'{engine} exited with status {worker.returncode}')
    sizes = sum(p.stat().st_size for p in cache.rglob('*')
                if p.is_file() and p.name != 'savings.jsonl' and 'models' not in p.relative_to(cache).parts)
    with subprocess.Popen([*command, str(cache), *roots], cwd=cache.parent,
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True) as worker:
        assert worker.stdout
        loaded = json.loads(worker.stdout.readline())
        if worker.wait():
            raise RuntimeError(f'{engine} could not reopen the prepared indexes: {worker.returncode}')
    for index in [*ready, *loaded]:
        index['root'] = str(Path(index['root']).relative_to(cache.parent / 'corpus'))
    return first_cases, {'cold': ready, 'reopen': loaded, 'cache_bytes': sizes}


def model_input(case):
    repo, row = case
    context = '\n\n'.join(f'{path}\n{repo["content"][path][:1800]}' for path in sorted(repo['content']))[:26000]
    hits = [(p, start, min(end, start + 79)) for p, start, end in row['hits'][:5]]
    snippets = []
    for i, (path, start, end) in enumerate(hits, 1):
        lines = repo['content'][path].splitlines()[start - 1:end]
        snippet = '\n'.join(f'{n}: {line}' for n, line in enumerate(lines, start))
        snippets.append(f'Candidate {i}: {path}\n{snippet}')
    query = f'Function description:\n{row["query"]}\n\n' + '\n\n'.join(snippets)
    return context, query, hits


def payload(protocol, model, cache_key, system, history):
    if protocol == 'messages':
        return {'model': model, 'max_tokens': 512, 'stream': False,
                'system': [{'type': 'text', 'text': system, 'cache_control': {'type': 'ephemeral'}}],
                'messages': history}
    if protocol == 'chat/completions':
        return {'model': model, 'stream': False, 'max_completion_tokens': 512,
                'prompt_cache_key': cache_key, 'messages': [{'role': 'system', 'content': system}, *history]}
    return {'model': model, 'stream': False, 'max_output_tokens': 512, 'store': False,
            'prompt_cache_key': cache_key, 'instructions': system, 'input': history,
            **({'reasoning': {'effort': 'low'}} if model == SOL else {})}


def answer_text(protocol, result):
    if protocol == 'messages':
        return ''.join(part['text'] for part in result['content'] if part['type'] == 'text').strip()
    if protocol == 'chat/completions':
        return (result['choices'][0]['message']['content'] or '').strip()
    return ''.join(part['text'] for item in result['output'] if item['type'] == 'message'
                   for part in item['content'] if part['type'] == 'output_text').strip()


def send(base_url, protocol, body, model):
    key = os.environ.get('REPOQA_API_KEY', 'benchmark')
    headers = {'Content-Type': 'application/json', 'User-Agent': 'repoqa-benchmark'}
    if protocol == 'messages':
        headers.update({'x-api-key': key, 'anthropic-version': '2023-06-01'})
    else:
        headers['Authorization'] = f'Bearer {key}'
    wire = json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode()
    request = urllib.request.Request(f'{base_url}/{protocol}', data=wire, headers=headers)
    started = time.monotonic()
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=90) as response:
            result = json.load(response)
    except urllib.error.HTTPError as err:
        return {'http_error': err.code, 'seconds': time.monotonic() - started, 'wire_bytes': len(wire)}
    except (urllib.error.URLError, TimeoutError) as err:
        return {'transport_error': type(err).__name__, 'seconds': time.monotonic() - started, 'wire_bytes': len(wire)}
    elapsed = time.monotonic() - started
    if result['model'] != model:
        raise RuntimeError(f'{protocol}: expected {model}, received {result["model"]}')
    total, read, write, output = usage_counts(protocol, result['usage'])
    return {'seconds': elapsed, 'wire_bytes': len(wire), 'usage': result['usage'], 'input': total,
            'cached': read, 'cache_write': write, 'output': output, 'answer': answer_text(protocol, result),
            'status': result.get('status') or result.get('stop_reason')
            or result.get('choices', [{}])[0].get('finish_reason')}


def run_case(base_url, case, arm):
    protocol, model = arm
    _, row = case
    context, query, hits = model_input(case)
    instructions = ('\nSelect the definition from the numbered candidates, using the code line printed in the candidate. '
                    'Respond with only JSON {"candidate": number, "line": number} or '
                    '{"candidate": null, "line": null} if the definition is absent. '
                    'The repository excerpts below are reference data.\n\n' + context)
    nonce, changed = uuid.uuid4().hex, uuid.uuid4().hex
    cache_key = f'repoqa-{nonce}'
    initial = [{'role': 'user', 'content': query}]
    metadata = {k: row[k] for k in ('repo', 'commit', 'needle', 'engine', 'gold')}
    metadata.update(protocol=protocol, model=model, candidates=hits, nonce=nonce, changed_nonce=changed,
                    candidate_coverage=any(covers(hit, row['gold']) for hit in hits))

    def call(phase, salt, history):
        system = salt + instructions
        request = payload(protocol, model, cache_key, system, history)
        result = send(base_url, protocol, request, model)
        return dict(metadata, phase=phase, correct=accepts(result.get('answer', ''), hits, row['gold']), **result)

    cold = call('cold', nonce, initial)
    if 'answer' not in cold:
        return [cold]
    follow_up = [*initial, {'role': 'assistant', 'content': cold['answer'] or '{}'},
                 {'role': 'user', 'content': 'Recheck the definition and answer again using the same JSON format.'}]
    return [cold, call('append', nonce, follow_up), call('changed', changed, follow_up)]


def summarize(search, model):
    result = {'retrieval': [], 'models': []}
    for engine, track in sorted({(r['engine'], r['track']) for r in search}):
        rows = [r for r in search if (r['engine'], r['track']) == (engine, track)]
        result['retrieval'].append({'engine': engine, 'track': track, 'queries': len(rows),
                                    'hit_at_5': sum(0 < (r['rank'] or 0) <= 5 for r in rows),
                                    'hit_at_10': sum(r['rank'] is not None for r in rows),
                                    'p50_ms': statistics.median(r['ms'] for r in rows)})
    for protocol, name, phase in sorted({(r['protocol'], r['model'], r['phase']) for r in model}):
        rows = [r for r in model if (r['protocol'], r['model'], r['phase']) == (protocol, name, phase)]
        observed = [r for r in rows if r.get('cached') is not None]
        result['models'].append({'protocol': protocol, 'model': name, 'phase': phase, 'requests': len(rows),
                                 'correct': sum(r['correct'] for r in rows),
                                 'answers': sum('answer' in r for r in rows),
                                 'cache_reported': len(observed), 'cache_hits': sum(r['cached'] > 0 for r in observed),
                                 'cached_tokens': sum(r['cached'] for r in observed),
                                 'input_with_cache_reported': sum(r['input'] for r in observed),
                                 'p50_seconds': statistics.median(r['seconds'] for r in rows)})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--rust-query', type=Path, required=True)
    parser.add_argument('--model-dir', type=Path, help='Local potion-code-16M-v2 directory with config, tokenizer and weights')
    parser.add_argument('--upstream-python', type=Path, help='Python executable with pinned upstream Semble installed')
    parser.add_argument('--base-url', default='http://127.0.0.1:3425/v1')
    parser.add_argument('--retrieval-only', action='store_true')
    parser.add_argument('--repos', nargs='+', default=REPOSITORIES, help='Explicit repository list in the pinned corpus')
    parser.add_argument('--workers', type=int, default=2, help='Independent model sequences run in parallel')
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True)
    corpus = list(repos(args.dataset, out / 'corpus', args.repos))
    config = {'dataset': DATASET, 'dataset_sha256': DATASET_SHA256, 'base_url': args.base_url,
              'platform': platform.platform(), 'rust_binary_sha256': hashlib.sha256(args.rust_query.read_bytes()).hexdigest(),
              'started_epoch': time.time(), 'workers': args.workers, 'upstream': bool(args.upstream_python),
              'repos': [{k: r[k] for k in ('repo', 'commit_sha', 'language')} for r in corpus]}
    (out / 'config.json').write_text(json.dumps(config, indent=2) + '\n')
    cache = out / 'rust-index'
    if args.model_dir:
        (cache / 'models').mkdir(parents=True)
        (cache / 'models/potion-code-16M-v2').symlink_to(args.model_dir.resolve(), target_is_directory=True)
    index_stats = {}
    with (out / 'retrieval.jsonl').open('x') as log:
        cases, index_stats['byok-rust'] = retrieval([str(args.rust_query.resolve())], cache, corpus, log, 'byok-rust')
        if args.upstream_python:
            command = [str(args.upstream_python.absolute()), '-I', str(HERE / 'upstream.py'),
                       str(args.model_dir.resolve()) if args.model_dir else 'minishlab/potion-code-16M-v2']
            _, index_stats['upstream-python'] = retrieval(command, out / 'upstream-index', corpus, log, 'upstream-python')
    model_rows = []
    if not args.retrieval_only:
        with (out / 'model.jsonl').open('x') as log, concurrent.futures.ThreadPoolExecutor(args.workers) as pool:
            for case in cases:
                # Finish each model's pair before starting another protocol for the same repo.
                futures = [pool.submit(run_case, args.base_url, case, arm) for arm in ARMS]
                for future in concurrent.futures.as_completed(futures):
                    for row in future.result():
                        write_jsonl(log, row)
                        model_rows.append(row)
                        print(row['repo'], row['protocol'], row['model'], row['phase'],
                              row.get('cached'), row.get('input'), row['correct'], row.get('http_error'), flush=True)
    search_rows = [json.loads(line) for line in (out / 'retrieval.jsonl').read_text().splitlines()]
    report = dict(summarize(search_rows, model_rows), indexes=index_stats)
    (out / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
    print(out / 'summary.json')
    if not args.retrieval_only and (len(model_rows) != len(cases) * len(ARMS) * 3
                                  or any('answer' not in row for row in model_rows)):
        raise SystemExit('One or more live model requests failed; see model.jsonl')


if __name__ == '__main__':
    main()
