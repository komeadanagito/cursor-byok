"""Measure search latency and evidence recall on fixed Google FRAMES questions."""

import argparse
import csv
import hashlib
import json
import re
import statistics
import subprocess
import time
from itertools import islice
import urllib.error
import urllib.parse
import urllib.request
from contextlib import ExitStack, contextmanager
from pathlib import Path

from benchmark import SWE, payload, send, write_jsonl

FRAMES_SETTING = 'https://huggingface.co/datasets/google/frames-benchmark/resolve/58d9fb6330f3ab1316d1eca12e5e8ef23dcc22ef/test.tsv'
FRAMES_SHA256 = '4255093c93b595b5b04c7c8dde290b48ec87d72ca0fb0b760d9dd02740d669ff'
EXA_URL = 'https://mcp.exa.ai/mcp?tools=web_search_exa'
WIKI_HOSTS = ('en.wikipedia.org', 'en.m.wikipedia.org')


def wiki_title(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.hostname in WIKI_HOSTS and parsed.path.startswith('/wiki/'):
        return urllib.parse.unquote(parsed.path.removeprefix('/wiki/')).replace('_', ' ')
    return None


def evidence(hits):
    articles, page_ids = set(), set()
    for url, _ in hits:
        if title := wiki_title(url):
            articles.add(title)
        elif (parsed := urllib.parse.urlsplit(url)).hostname in WIKI_HOSTS:
            page_ids.update(id_ for id_ in urllib.parse.parse_qs(parsed.query).get('curid', []) if id_.isdigit())
    if page_ids:
        params = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'pageids': '|'.join(sorted(page_ids))})
        request = urllib.request.Request(f'https://en.wikipedia.org/w/api.php?{params}', headers={
            'User-Agent': 'RepoQA-FRAMES-benchmark/1.0 (public evidence resolution)',
        })
        with urllib.request.urlopen(request, timeout=15) as response:
            pages = json.load(response)['query']['pages']
        articles.update(page['title'] for page in pages.values() if 'missing' not in page)
    return articles


class Exa:
    def __init__(self):
        self.headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
                        'User-Agent': 'public-search-eval'}
        result = self.rpc({'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': '2025-03-26', 'capabilities': {},
            'clientInfo': {'name': 'frames-benchmark', 'version': '1.0'},
        }})
        assert result is not None
        self.headers['MCP-Protocol-Version'] = result['protocolVersion']
        self.rpc({'method': 'notifications/initialized'})

    def rpc(self, rpc):
        req = urllib.request.Request(EXA_URL, json.dumps({'jsonrpc': '2.0', **rpc}).encode(), self.headers)
        with urllib.request.urlopen(req, timeout=20) as response:
            if session := response.headers.get('Mcp-Session-Id'):
                self.headers['Mcp-Session-Id'] = session
            if 'id' not in rpc:
                return None
            if response.headers.get_content_type() == 'text/event-stream':
                for line in response:
                    if line.startswith(b'data:'):
                        reply = json.loads(line[5:])
                        if reply.get('id') == rpc['id']:
                            break
                else:
                    raise ValueError('Exa SSE closed before its RPC response')
            else:
                reply = json.load(response)
        return reply['result']

    def search(self, query, limit):
        started = time.monotonic()
        result = self.rpc({'id': 2, 'method': 'tools/call', 'params': {
            'name': 'web_search_exa', 'arguments': {'query': query, 'numResults': limit},
        }})
        seconds = time.monotonic() - started
        assert result is not None
        if result.get('isError'):
            return {'seconds': seconds, 'error': str(result['content'])}
        text = '\n'.join(item['text'] for item in result['content'] if item['type'] == 'text')
        urls = list(dict.fromkeys(re.findall(r'^URL:\s*(https?://\S+)', text, flags=re.MULTILINE)))
        if not urls:
            return {'seconds': seconds, 'error': 'Exa response contained no URL fields'}
        return {'seconds': seconds, 'hits': [(url, '') for url in urls[:limit]]}


@contextmanager
def federation(path):
    with subprocess.Popen([str(path.resolve())], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as process:
        input_stream, output_stream = process.stdin, process.stdout
        assert input_stream and output_stream

        def search(query, limit):
            write_jsonl(input_stream, query)
            result = json.loads(output_stream.readline())
            if 'hits' in result:
                result['hits'] = result['hits'][:limit]
            return result

        try:
            yield search
        finally:
            input_stream.close()
            if process.wait():
                raise RuntimeError(f'{path.name} exited with status {process.returncode}')


def searxng(url, query, limit):
    params = urllib.parse.urlencode({'q': query, 'format': 'json', 'language': 'en'})
    request = urllib.request.Request(f'{url.rstrip("/")}/search?{params}', headers={'User-Agent': 'public-search-eval'})
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=20) as response:
        data = json.load(response)
    return {'seconds': time.monotonic() - started,
            'hits': [(row['url'], row['title']) for row in data['results'][:limit]],
            'unresponsive_engines': data.get('unresponsive_engines', [])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--current', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--start', type=int, default=0, help='First FRAMES row (zero-based)')
    parser.add_argument('--count', type=int, default=6, help='Number of consecutive FRAMES rows')
    parser.add_argument('--queries-from', type=Path, help='Reuse queries from an earlier web.jsonl')
    parser.add_argument('--searxng-url', help='Benchmark a configured SearXNG instance with JSON enabled')
    parser.add_argument('--base-url', default='http://127.0.0.1:3425/v1')
    args = parser.parse_args()
    if args.start < 0 or args.count < 1:
        parser.error('--start must be nonnegative and --count positive')
    if hashlib.sha256(args.dataset.read_bytes()).hexdigest() != FRAMES_SHA256:
        raise ValueError('FRAMES dataset does not match the pinned SHA-256')
    with args.dataset.open(newline='') as source:
        reader = csv.DictReader(source, delimiter='\t')
        cases = list(islice(reader, args.start, args.start + args.count))
    if len(cases) != args.count:
        parser.error('requested slice exceeds the FRAMES dataset')
    fixed = {}
    if args.queries_from:
        for line in args.queries_from.read_text().splitlines():
            row = json.loads(line)
            previous = fixed.setdefault(row['id'], row)
            if previous['query'] != row['query']:
                raise ValueError(f'FRAMES {row["id"]}: fixed queries disagree')
    args.out.mkdir(parents=True)
    with ExitStack() as stack:
        before = stack.enter_context(federation(args.baseline))
        after = stack.enter_context(federation(args.current))
        try:
            exa = Exa().search
        except (urllib.error.URLError, TimeoutError) as error:
            print(f'Exa initialization failed: {error}', flush=True)
            exa = None
        output = stack.enter_context((args.out / 'web.jsonl').open('x'))
        rows = []
        for index, case in enumerate(cases):
            instruction = 'Return one concise, standalone web search query for finding evidence to answer the question. Output the query alone.'
            if args.queries_from:
                row = fixed[case['']]
                query, model = row['query'], row['generator']
            else:
                body = payload('messages', SWE, '', instruction, [{'role': 'user', 'content': case['Prompt']}])
                model = send(args.base_url, 'messages', body, SWE)
                query = model.get('answer', '').strip('"')
            if not query or '\n' in query:
                raise ValueError(f'FRAMES {index}: SWE-2 failed to produce one query: {model}')
            gold = {title for key, url in case.items() if key.startswith('wikipedia_link_') and url
                    if (title := wiki_title(url)) is not None}
            order = [('baseline', before), ('current', after)]
            if args.searxng_url:
                order.append(('searxng', lambda query, limit: searxng(args.searxng_url, query, limit)))
            if exa is not None:
                order.append(('exa-anonymous', exa))
            for name, search in order if index % 2 == 0 else order[::-1]:
                started = time.monotonic()
                try:
                    result = search(query, 10)
                except (urllib.error.URLError, TimeoutError) as error:
                    result = {'seconds': time.monotonic() - started, 'error': str(error)}
                hits = evidence(result.get('hits', []))
                row = {'id': case[''], 'question': case['Prompt'], 'query': query, 'query_model': SWE,
                       'generator': model, 'backend': name, 'gold': sorted(gold), 'matched': sorted(gold & hits), **result}
                write_jsonl(output, row)
                rows.append(row)
                print(row['id'], name, len(row['matched']), len(gold), round(row['seconds'], 3), flush=True)
        report = {'source': FRAMES_SETTING, 'sha256': FRAMES_SHA256, 'k': 10, 'backends': []}
        for backend in dict.fromkeys(r['backend'] for r in rows):
            rows_for_backend = [r for r in rows if r['backend'] == backend]
            report['backends'].append({'backend': backend, 'questions': len(rows_for_backend),
                                       'at_least_one': sum(bool(r['matched']) for r in rows_for_backend),
                                       'matched_links': sum(len(r['matched']) for r in rows_for_backend),
                                       'expected_links': sum(len(r['gold']) for r in rows_for_backend),
                                       'p50_seconds': statistics.median(r['seconds'] for r in rows_for_backend),
                                       'errors': sum('error' in r for r in rows_for_backend)})
    (args.out / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
