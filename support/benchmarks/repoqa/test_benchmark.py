"""Checks the gold span, model answer and protocol usage rules independently of a live provider."""

import runpy
import unittest
from pathlib import Path

from benchmark import accepts, gold, usage_counts
from cache_continuation import response_stream_event
from hybrid_retrieval import interleave
from miss_audit import miss_stage
from web import wiki_title


class BenchmarkRules(unittest.TestCase):
    def test_repeated_queries_are_latency_samples_not_additional_quality_hits(self):
        metrics = runpy.run_path(str(Path(__file__).parent / 'results/2026-11-22/search-proof/compare.py'))['metrics']
        rows = [{'id': q, 'ms': 1, 'rank': rank} for q, ranks in [('a', [1] * 8), ('b', [1] + [None] * 7)] for rank in ranks]
        report = metrics(rows)
        self.assertEqual(report['questions'], 2)
        self.assertEqual(report['timed_samples'], 16)
        self.assertEqual(report['questions_hit_on_every_run'][10], 1)

    def test_gold_offsets_measure_utf8_bytes_and_return_one_based_lines(self):
        text = '# é\ndef wanted():\n    return 1\n'
        start = len('# é\n'.encode())
        needle = {'path': 'example.py', 'start_byte': start, 'end_byte': len(text.encode()), 'name': 'wanted'}
        self.assertEqual(gold({'content': {'example.py': text}}, needle), ('example.py', 2, 'wanted'))

    def test_model_must_select_the_candidate_and_the_actual_definition_line(self):
        hits = [('uses.py', 1, 40), ('example.py', 1, 40), ('example.py', 9, 15)]
        expected = ('example.py', 10, 'wanted')
        self.assertTrue(accepts('{"candidate":2,"line":10}', hits, expected))
        self.assertFalse(accepts('{"candidate":1,"line":10}', hits, expected))
        self.assertFalse(accepts('{"candidate":2,"line":11}', hits, expected))
        self.assertFalse(accepts('{"candidate":true,"line":10}', hits, expected))
        self.assertFalse(accepts('unstructured answer', hits, expected))

    def test_miss_audit_separates_index_coverage_from_rank_and_file_only_matches(self):
        target = ('a.rs', 20, 'area')
        base = {'file_indexed': True, 'covering_chunks': 1, 'hits': [('a.rs', 1, 19)]}
        self.assertEqual(miss_stage({**base, 'file_indexed': False}, target), ('file_not_indexed', None))
        self.assertEqual(miss_stage({**base, 'covering_chunks': 0}, target), ('definition_line_not_chunked', None))
        self.assertEqual(miss_stage(base, target), ('not_in_expanded_top_100', None))
        self.assertEqual(miss_stage({**base, 'hits': [('a.rs', 1, 19)] * 10 + [('a.rs', 20, 50)]}, target),
                         ('ranked_below_top_10', 11))

    def test_hybrid_keeps_a_complementary_definition_within_a_fixed_budget(self):
        same = ['shared.py', 1, 4]
        lexical = ['old.py', 3, 8]
        semantic = ['wanted.py', 7, 10]
        self.assertEqual(interleave([same, lexical], [same, semantic])[:3], [same, lexical, semantic])
        self.assertEqual(interleave([], [semantic]), [semantic])

    def test_wikipedia_evidence_normalizes_format_without_matching_unrelated_sites(self):
        self.assertEqual(wiki_title('https://en.m.wikipedia.org/wiki/Charlotte_Bront%C3%AB#Life'),
                         'Charlotte Brontë')
        self.assertIsNone(wiki_title('https://example.com/wiki/Charlotte_Bront%C3%AB'))

    def test_responses_reads_cache_from_terminal_usage_not_the_first_delta(self):
        usage = {}
        self.assertEqual(response_stream_event({'type': 'response.output_text.delta', 'delta': 'answer'}, usage), 'answer')
        self.assertEqual(usage, {})
        self.assertIsNone(response_stream_event({'type': 'response.completed', 'response': {
            'model': 'devin/swe-2', 'usage': {'input_tokens': 8000, 'input_tokens_details': {'cached_tokens': 7800}, 'output_tokens': 20},
        }}, usage))
        self.assertEqual(usage_counts('responses', usage), (8000, 7800, None, 20))
        with self.assertRaises(ValueError):
            response_stream_event({'type': 'response.failed', 'response': {'error': {'message': 'failed'}}}, usage)

    def test_messages_adds_reads_and_writes_but_openai_already_includes_them(self):
        self.assertEqual(usage_counts('messages', {
            'input_tokens': 20, 'cache_read_input_tokens': 100,
            'cache_creation_input_tokens': 80, 'output_tokens': 5,
        }), (200, 100, 80, 5))
        self.assertEqual(usage_counts('chat/completions', {
            'prompt_tokens': 200, 'prompt_tokens_details': {'cached_tokens': 100},
            'completion_tokens': 5,
        }), (200, 100, None, 5))
        self.assertEqual(usage_counts('responses', {
            'input_tokens': 200, 'input_tokens_details': {'cached_tokens': 0},
            'output_tokens': 5,
        }), (200, 0, None, 5))
        self.assertEqual(usage_counts('responses', {'input_tokens': 200, 'output_tokens': 5}),
                         (200, None, None, 5))


if __name__ == '__main__':
    unittest.main()
