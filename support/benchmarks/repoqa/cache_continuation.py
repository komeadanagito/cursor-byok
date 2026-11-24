"""Compare SWE-2 warm continuation with and without pi-style session affinity."""

import argparse
import concurrent.futures
import gzip
import hashlib
import json
import statistics
import time
import urllib.request
import uuid
from pathlib import Path

from benchmark import (
    DATASET_SHA256,
    SWE,
    accepts,
    model_input,
    usage_counts,
    write_jsonl,
)

PROTOCOLS = ('messages', 'chat/completions', 'responses')


def response_stream_event(event, usage):
    kind = event.get('type')
    if kind == 'response.output_text.delta':
        return event['delta']
    if kind == 'response.failed':
        raise ValueError(event['response']['error'])
    if kind in ('response.completed', 'response.incomplete'):
        response = event['response']
        if response['model'] != SWE:
            raise ValueError(f'Unexpected Responses model: {response["model"]}')
        usage.update(response['usage'])
    return None


def stream_call(protocol, body, session):
    headers = {'Content-Type': 'application/json', 'User-Agent': 'cache-benchmark'}
    if protocol == 'messages':
        headers.update({'x-api-key': 'benchmark', 'anthropic-version': '2023-06-01'})
    else:
        headers['Authorization'] = 'Bearer benchmark'
    if session is not None:
        headers.update({'session_id': session, 'x-client-request-id': session, 'x-session-affinity': session})
    request = urllib.request.Request(f'http://127.0.0.1:3425/v1/{protocol}', json.dumps(body).encode(), headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    usage = {}
    answer = []
    first_text = None
    started = time.monotonic()
    with opener.open(request, timeout=90) as stream:
        for line in stream:
            if not line.startswith(b'data:'):
                continue
            data = line[5:].strip()
            if data == b'[DONE]':
                break
            event = json.loads(data)
            if event.get('type') == 'error' or event.get('error'):
                raise ValueError(event)
            if protocol == 'messages':
                if event.get('type') == 'message_start':
                    if event['message']['model'] != SWE:
                        raise ValueError(f'Unexpected Messages model: {event["message"]["model"]}')
                    usage.update(event['message'].get('usage') or {})
                if event.get('type') == 'message_delta':
                    usage.update(event.get('usage') or {})
                if event.get('type') == 'content_block_delta' and event['delta'].get('type') == 'text_delta':
                    answer.append(event['delta']['text'])
            elif protocol == 'responses':
                if text := response_stream_event(event, usage):
                    answer.append(text)
            else:
                if event.get('model', SWE) != SWE:
                    raise ValueError(f'Unexpected Chat Completions model: {event["model"]}')
                usage.update(event.get('usage') or {})
                for choice in event.get('choices') or []:
                    if text := choice.get('delta', {}).get('content'):
                        answer.append(text)
            if answer and first_text is None:
                first_text = time.monotonic() - started
    count, cached, written, output = usage_counts(protocol, usage)
    if cached is None:
        raise ValueError('The model stream did not report cache reads')
    return {'usage': usage, 'input': count, 'cached': cached, 'written': written, 'output': output,
            'answer': ''.join(answer), 'first_text': first_text, 'elapsed': time.monotonic() - started}


def session_run(repo, row, protocol, affinity, rounds, context_chars):
    context, query, hits = model_input((repo, row))
    if context_chars:
        context = '\n\n'.join(f'{path}\n{repo["content"][path]}' for path in sorted(repo['content']))[:context_chars]
    system = (f'Benchmark {uuid.uuid4()}. Select the numbered candidate and its definition line from the public source. '
              'Respond with only JSON {"candidate":number,"line":number} or {"candidate":null,"line":null}. '
              f'Repository reference:\n{context}')
    session = uuid.uuid4().hex if affinity else None
    history = [{'role': 'user', 'content': query}]
    results = []
    for turn in range(rounds):
        if protocol == 'messages':
            messages = []
            for index, message in enumerate(history):
                block = {'type': 'text', 'text': message['content']}
                content = dict(block, cache_control={'type': 'ephemeral'}) if index + 1 == len(history) else block
                messages.append({'role': message['role'], 'content': [content]})
            body = {'model': SWE, 'stream': True, 'max_tokens': 384,
                    'system': [{'type': 'text', 'text': system, 'cache_control': {'type': 'ephemeral'}}],
                    'messages': messages}
        elif protocol == 'responses':
            body = {'model': SWE, 'stream': True, 'instructions': system, 'input': history,
                    'store': False, 'max_output_tokens': 384}
        else:
            body = {'model': SWE, 'stream': True, 'stream_options': {'include_usage': True},
                    'max_completion_tokens': 384, 'messages': [{'role': 'system', 'content': system}, *history]}
        stats = stream_call(protocol, body, session)
        results.append(dict(stats, turn=turn, repo=row['repo'], protocol=protocol, affinity=affinity,
                            session=session, correct=accepts(stats['answer'], hits, row['gold'])))
        if not stats['answer']:
            raise ValueError(f'{protocol}: no assistant content to continue from')
        history.extend([{'role': 'assistant', 'content': stats['answer']},
                        {'role': 'user', 'content': f'Recheck the original question and respond with the same JSON format. Follow-up {turn + 1}.'}])
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--retrieval', type=Path, required=True, help='retrieval.jsonl produced by benchmark.py')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--rounds', type=int, default=4)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--context-chars', type=int, default=0)
    parser.add_argument('--repos', nargs='+')
    parser.add_argument('--protocols', nargs='+', choices=PROTOCOLS, default=PROTOCOLS)
    args = parser.parse_args()
    raw = args.dataset.read_bytes()
    if hashlib.sha256(raw).hexdigest() != DATASET_SHA256:
        raise ValueError('RepoQA gzip does not match the pinned SHA-256')
    by_name = {repo['repo']: repo for repos in json.loads(gzip.decompress(raw)).values() for repo in repos}
    rows = [row for line in args.retrieval.read_text().splitlines() if (row := json.loads(line))['track'] == 'description'
            and row['needle'] == 0 and row['engine'] == 'byok-rust' and (not args.repos or row['repo'] in args.repos)]
    if not rows or args.rounds < 2:
        parser.error('At least one repository and one continuation are required')
    arms = [(protocol, affinity) for protocol in args.protocols for affinity in (False, True)]
    results = []
    with args.out.open('x') as output, concurrent.futures.ThreadPoolExecutor(args.workers) as pool:
        for index, row in enumerate(rows):
            jobs = [pool.submit(session_run, by_name[row['repo']], row, protocol, affinity, args.rounds, args.context_chars)
                    for protocol, affinity in (arms if index % 2 == 0 else arms[::-1])]
            for job in concurrent.futures.as_completed(jobs):
                sequence = job.result()
                results.extend(sequence)
                for item in sequence:
                    write_jsonl(output, item)
                first = sequence[0]
                print(first['repo'], first['protocol'], first['affinity'], [(r['cached'], r['input']) for r in sequence], flush=True)
    for protocol, affinity in arms:
        warm = [r for r in results if (r['protocol'], r['affinity']) == (protocol, affinity) and r['turn']]
        share = 100 * sum(r['cached'] for r in warm) / sum(r['input'] for r in warm)
        sustained = sum(r['cached'] / r['input'] >= 0.95 for r in warm)
        print(protocol, affinity, len(warm), f'{share:.2f}%', '>=95%', sustained,
              'P50 first text', round(statistics.median(r['first_text'] for r in warm), 2),
              'P50 seconds', round(statistics.median(r['elapsed'] for r in warm), 2), flush=True)


if __name__ == '__main__':
    main()
