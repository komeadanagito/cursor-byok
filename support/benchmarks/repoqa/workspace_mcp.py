"""Exercise the extension's registered stdio servers on public RepoQA and SCIP fixtures."""

import argparse
import asyncio
import hashlib
import json
import os
import platform
import re
import shutil
import statistics
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path

from .benchmark import DATASET_SHA256, covers, gold, repos, write_jsonl

EXTENSION = Path(__file__).resolve().parents[3] / 'apps/workspace-symbols'
SCIP_COMMIT = '7f51391d9770c63be2449463c8eb89f98c9e1468'
REGISTER = '''
const path = require('node:path');
const [extension, root, serena, semble] = process.argv.slice(1);
const servers = {};
const subscription = () => ({dispose() {}});
require(path.join(extension, 'extension.cjs')).activate({
  subscriptions: [], asAbsolutePath: file => path.join(extension, file),
}, {
  commands: {registerCommand: subscription},
  workspace: {
    isTrusted: true,
    workspaceFolders: [{name: path.basename(root), uri: {fsPath: root, toString: () => `file://${root}`}}],
    getConfiguration: () => ({get: key => ({executable: serena, semanticExecutable: semble})[key]}),
    onDidChangeWorkspaceFolders: subscription,
  },
  cursor: {mcp: {registerServer({name, server}) {servers[name.split('-')[0]] = server;}, unregisterServer() {}}},
});
process.stdout.write(JSON.stringify(servers));
'''


def registrations(root, args):
    return json.loads(subprocess.check_output([
        'node', '-e', REGISTER, str(EXTENSION), str(root), str(args.serena), str(args.semble),
    ], timeout=10))


@asynccontextmanager
async def start(server, env, log):
    started = time.monotonic()
    with log.open('ab') as stderr:
        process = await asyncio.create_subprocess_exec(
            server['command'], *server['args'], env={**env, **server['env']},
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=stderr,
            limit=4 * 1024 * 1024,
        )
        stdin, stdout = process.stdin, process.stdout
        assert stdin and stdout
        counter = 0

        async def send(message):
            stdin.write((json.dumps({'jsonrpc': '2.0', **message}) + '\n').encode())
            await stdin.drain()

        async def rpc(method, params):
            nonlocal counter
            counter += 1
            await send({'id': counter, 'method': method, 'params': params})

            async def receive():
                while line := await stdout.readline():
                    reply = json.loads(line)
                    if reply.get('id') == counter:
                        return reply['result']
                raise RuntimeError(f'{method}: stdio closed, see {log}')

            return await asyncio.wait_for(receive(), 90)

        try:
            handshake = await rpc('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                                                 'clientInfo': {'name': 'public-search-eval', 'version': '1'}})
            await send({'method': 'notifications/initialized'})
            tools = {tool['name']: tool['inputSchema'] for tool in (await rpc('tools/list', {}))['tools']}
            yield rpc, tools, {'ready_ms': (time.monotonic() - started) * 1000, 'server': handshake['serverInfo']}
        finally:
            stdin.close()
            try:
                await asyncio.wait_for(process.wait(), 10)
            except TimeoutError:
                process.kill()
                await process.wait()
                raise RuntimeError(f'MCP server did not exit after closing stdio, see {log}') from None
        if process.returncode:
            raise RuntimeError(f'MCP exit {process.returncode}, see {log}')


async def call(rpc, tool, arguments):
    started = time.monotonic()
    result = await rpc('tools/call', {'name': tool, 'arguments': arguments})
    return result, (time.monotonic() - started) * 1000


def text(result):
    return result['content'][0]['text']


def decode(result):
    assert not result.get('isError'), result
    return json.loads(text(result))


async def search(rpc, query):
    result, ms = await call(rpc, 'search', {'query': query, 'top_k': 10, 'max_snippet_lines': 0})
    hits = [(hit['file_path'], hit['start_line'], hit['end_line']) for hit in decode(result)['results']]
    return hits, ms


async def retrieval(args, env, log, rows):
    measurements = []
    for repo in repos(args.dataset, args.out / 'corpus'):
        server = registrations(repo['root'], args)['semantic']
        cases = [(gold(repo, needle), needle['description'].strip()) for needle in repo['needles']]
        async with start(server, env, log) as (rpc, tools, cold):
            assert set(tools) == {'search', 'find_related'}
            assert all('repo' not in schema['properties'] for schema in tools.values())
            first_hits, first_ms = await search(rpc, cases[0][1])
            for index, (expected, description) in enumerate(cases):
                for track, query in [('description', description), ('symbol', expected[2])]:
                    if index == 0 and track == 'description':
                        hits, ms = first_hits, first_ms
                    else:
                        hits, ms = await search(rpc, query)
                    row = {'repo': repo['repo'], 'commit': repo['commit_sha'], 'track': track, 'needle': index, 'gold': expected,
                               'hits': hits, 'ms': ms, 'rank': next((i for i, hit in enumerate(hits, 1) if covers(hit, expected)), None)}
                    write_jsonl(rows, row)
        async with start(server, env, log) as (rpc, _, reopen):
            hits, ms = await search(rpc, cases[0][1])
            assert hits == first_hits, repo['repo']
        measurements.append({'repo': repo['repo'], 'cold': {**cold, 'first_ms': first_ms},
                                 'reopen': {**reopen, 'first_ms': ms}})
        print(f'{repo["repo"]}: cold {first_ms:.0f} ms, reopen {ms:.0f} ms', flush=True)
    return measurements


async def symbols_and_errors(args, env, log):
    root = args.out / 'syntax'
    shutil.copytree(args.scip / 'input/syntax', root)
    fixture = args.scip / 'output/syntax/src'
    source = (fixture / 'import.ts').read_text()
    assert 'definition ' in source and 'newFunction().' in source
    servers = registrations(root, args)
    semantic, symbols = servers['semantic'], servers['symbols']
    invalid_model = dict(env, SEMBLE_MODEL_NAME=str(args.out / 'missing-model'))
    async with start(semantic, invalid_model, log) as (search_rpc, _, _):
        failed, _ = await call(search_rpc, 'search', {'query': 'newFunction'})
        assert failed['isError'] and text(failed).startswith('Failed to index '), failed
        async with start(symbols, env, log) as (rpc, tools, service):
            cases = [
                ('get_symbols_overview', None, 'src/import.ts'),
                ('find_symbol', 'newFunction', 'src/function.ts'),
                ('find_referencing_symbols', 'newFunction', 'src/function.ts'),
                ('find_implementations', 'Superinterface/interfaceMethod', 'src/reusable-types.ts'),
                ('find_symbol', 'BYOKDoesNotExist91f3a7', 'src/function.ts'),
            ]
            assert set(tools) == {case[0] for case in cases}
            replies = []
            for tool, name, path in cases:
                params = {'relative_path': path}
                if name:
                    key = 'name_path_pattern' if 'name_path_pattern' in tools[tool]['properties'] else 'name_path'
                    params[key] = name
                result, ms = await call(rpc, tool, params)
                replies.append({'tool': tool, 'ms': ms, 'data': decode(result)})
    overview, definitions, references, implementations, missing = [row['data'] for row in replies]
    assert {'dynamicImport', 'useEverything'} <= set(overview['Function'])
    assert [(x['relative_path'], x['body_location']['start_line']) for x in definitions] == [('src/function.ts', 0)]
    ref_lines = {int(n) + 1 for group in references['src/import.ts'].values() for ref in group
                 for n in re.findall(r'^\s*>\s*(\d+):', ref['content_around_reference'], re.MULTILINE)}
    assert ref_lines == {4, 12, 18}, ref_lines
    names = {x['name_path'] for x in implementations if x['relative_path'] == 'src/inheritance.ts'}
    assert {'Subclass/interfaceMethod', 'objectLiteralImplementation/interfaceMethod'} <= names
    assert missing == [], missing
    async with start(symbols, env, log) as (rpc, tools, restarted):
        result, ms = await call(rpc, 'find_symbol', {'name_path_pattern': 'newFunction', 'relative_path': 'src/function.ts'})
        assert decode(result) == definitions
        restarted['first_ms'] = ms
    async with start(semantic, env, log) as (rpc, _, restored):
        hits, ms = await search(rpc, 'newFunction')
        assert any(covers(hit, ('src/function.ts', 1)) for hit in hits), hits
        related, related_ms = await call(rpc, 'find_related', {'file_path': 'src/function.ts', 'line': 1})
        assert decode(related)['results'], related
    return {'scip_commit': SCIP_COMMIT, 'service': service, 'tools': replies, 'reference_lines': sorted(ref_lines),
                'restart': restarted, 'broken_model_is_error': True, 'symbols_available_during_semantic_error': True,
                'semantic_recovery': dict(**restored, first_ms=ms, hits=hits, related_ms=related_ms)}


async def branch_switch(args, env, log):
    root = args.out / 'branch-fixture'
    root.mkdir()

    def git(*command):
        subprocess.run(['git', '-C', str(root), '-c', 'commit.gpgsign=false',
                        '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Search Fixture',
                        '-c', 'user.email=fixture@example.invalid', *command],
                       check=True, capture_output=True, timeout=15)

    git('init', '-q', '-b', 'before')
    (root / 'original.py').write_text('def calculate_invoice():\n    return sum([7, 9])\n')
    git('add', '.')
    git('commit', '-qm', 'Original fixture')
    git('switch', '-qc', 'after')
    (root / 'original.py').unlink()
    (root / 'replacement.py').write_text('def calculate_refund():\n    return sum([3, 5])\n')
    git('add', '-A')
    git('commit', '-qm', 'Replace invoice with refund')
    git('switch', '-q', 'before')

    server = registrations(root, args)['semantic']
    async with start(server, env, log) as (rpc, _, _):
        hits, cold = await search(rpc, 'calculate_invoice')
        assert covers(hits[0], ('original.py', 1)), hits
        hits, warm = await search(rpc, 'calculate_invoice')
        assert covers(hits[0], ('original.py', 1)), hits
        git('switch', '-q', 'after')
        switched_at = time.monotonic()
        first_query_ms = None
        while True:
            hits, query_ms = await search(rpc, 'calculate_refund')
            if first_query_ms is None:
                first_query_ms = query_ms
            if hits and covers(hits[0], ('replacement.py', 1)) and all(hit[0] != 'original.py' for hit in hits):
                break
            if time.monotonic() - switched_at > 10:
                raise AssertionError(f'Semble did not refresh after a branch checkout: {hits}')
            await asyncio.sleep(0.1)
        refreshed = (time.monotonic() - switched_at) * 1000
    async with start(server, env, log) as (rpc, _, _):
        restarted_hits, reopened = await search(rpc, 'calculate_refund')
        assert restarted_hits == hits, restarted_hits
    return {'cold_ms': cold, 'warm_ms': warm, 'first_query_after_switch_ms': first_query_ms,
            'fresh_results_after_switch_ms': refreshed, 'reopened_ms': reopened}


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('dataset', 'out', 'model', 'scip', 'semble', 'serena'):
        parser.add_argument(f'--{flag}', type=Path, required=True)
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True)
    cache = args.out / 'cache'
    env = dict(os.environ, SEMBLE_CACHE_LOCATION=str(cache), SEMBLE_MODEL_NAME=str(args.model.resolve()),
               HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
    log = args.out / 'servers.stderr.log'
    symbols = await symbols_and_errors(args, env, log)
    checkout = await branch_switch(args, env, log)
    print(f'Branch checkout: updated results in {checkout["fresh_results_after_switch_ms"]:.0f} ms', flush=True)
    print('SCIP fixture: outline, definition, references, implementations, missing symbol and restart passed', flush=True)
    with (args.out / 'retrieval.jsonl').open('x') as rows:
        processes = await retrieval(args, env, log, rows)
    rows = [json.loads(line) for line in (args.out / 'retrieval.jsonl').read_text().splitlines()]
    retrieval_stats = {}
    for track in ('description', 'symbol'):
        arm = [row for row in rows if row['track'] == track]
        hot = [row['ms'] for row in arm if row['needle'] or track == 'symbol']
        retrieval_stats[track] = {'queries': len(arm), 'hit_at_5': sum(row['rank'] is not None and row['rank'] <= 5 for row in arm),
                                      'hit_at_10': sum(row['rank'] is not None for row in arm), 'hot_p50_ms': statistics.median(hot)}
    manifest = {name: hashlib.sha256((EXTENSION / name).read_bytes()).hexdigest()
                for name in ('extension.cjs', 'semantic.cjs', 'symbols.yml')}
    result = {'platform': platform.platform(), 'dataset_sha256': DATASET_SHA256, 'extension_sha256': manifest,
                  'cache_bytes': sum(p.stat().st_size for p in cache.rglob('*') if p.is_file()),
                  'symbols': symbols, 'semantic': {'processes': processes, 'retrieval': retrieval_stats, 'branch_switch': checkout}}
    (args.out / 'report.json').write_text(json.dumps(result, indent=2) + '\n')
    print(args.out / 'report.json')


if __name__ == '__main__':
    asyncio.run(main())
