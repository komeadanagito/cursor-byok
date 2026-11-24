# SWE‑2 连续会话缓存复测

## 对照

- **pi 实际用量**为本机按最近修改时间取 75 个会话文件，从中找到 22 个包含 SWE‑2 的会话，共 1,291 次报告输入用量的 `openai-completions` 请求。输入中位数 73,705 token，总缓存读取占输入 95.91%，其中 1,135 次单请求达到 95%。只保留汇总。
- **短上下文、并发四组**使用 RepoQA `2024-06-23` 六个仓库的第 0 题。每个仓库跑 Messages / Chat Completions × 无亲和 / 同会话亲和，每组先发一次冷请求，再追加三轮。总共 96 次 SSE 请求。输入约 5.8K–11.2K。
- **短上下文、单会话顺序**用 Black 的同一题，每组合计六轮 Chat Completions，约 8.9K–9.2K 输入，共 12 次 SSE 请求。
- **长上下文、单会话顺序**使用同一数据包的 Black 第 0 题和该仓库固定顺序的公开源码。每组先冷启动再追加五轮，约 60.7K–61.1K 输入，共 24 次 SSE 请求。

一个组内的系统提示和历史稳定，后续只追加上一轮模型文本以及复核请求。各组使用各自的首部随机标识，减少冷请求互相预热。亲和组按 pi 1.5.2 的 Magpie 设置发送三个相同会话头 `session_id`、`x-client-request-id`、`x-session-affinity`。两个协议的长会话中，本机 Magpie 的亲和表均可按实验生成的会话 ID 匹配到一条记录，均累计了六轮。所有模型实际返回的 `model` 均为 `devin/swe-2`。

## 结果

| 协议 | 场景 | 无亲和缓存输入占比 | 有亲和缓存输入占比 | 无 / 有亲和达到 95% 的追加请求 |
|---|---|---:|---:|---:|
| Messages | 短、四组并发 | 57.24% | 46.49% | 10/18 · 8/18 |
| Chat Completions | 短、四组并发 | 53.84% | 49.46% | 9/18 · 8/18 |
| Chat Completions | 短、顺序 | 80.11% | 79.81% | 4/5 · 4/5 |
| Messages | 长、顺序 | 99.87% | 99.88% | 5/5 · 5/5 |
| Chat Completions | 长、顺序 | 99.86% | 99.86% | 5/5 · 5/5 |

占比是追加请求的 `Σ cache_read / Σ context_input`，排除每组建立会话的首次请求。短并发样本有的只读到 448 个缓存 token，有的读取了几乎全部输入。Black 短顺序对照里，两组也各有一次只读 448。上下文长度、并行度及运行时段在不同工作负载中共同变化，无法从这些数据单独归因。亲和头保证网关有稳定的会话路由标识，当前样本未观察到缓存率提升。SWE‑2 的连续长上下文已有稳定的高缓存读取。这里测的是公共题库到 Magpie 的流式请求，Cursor 实际长会话还会受工具、规则、模型切换与压缩影响。

## 复跑

从仓库根目录执行。把 `REPOQA_DATASET` 指向原始 RepoQA 发布 gzip。基准会验证 SHA‑256，并复用已归档的候选。命令只发公开源码到本机 Magpie，不读取实际 pi/Cursor 对话。

```bash
python3 support/benchmarks/repoqa/cache_continuation.py \
  --dataset "$REPOQA_DATASET" \
  --retrieval support/benchmarks/repoqa/results/2026-11-21/repoqa/retrieval.jsonl \
  --out /tmp/swe-cache-short-parallel.jsonl

python3 support/benchmarks/repoqa/cache_continuation.py \
  --dataset "$REPOQA_DATASET" \
  --retrieval support/benchmarks/repoqa/results/2026-11-21/repoqa/retrieval.jsonl \
  --out /tmp/swe-cache-long-sequential.jsonl \
  --context-chars 250000 --repos psf/black --rounds 6 --workers 1
```

[短并发逐请求记录](short-parallel.jsonl) · [短顺序逐请求记录](short-sequential.jsonl) · [长顺序逐请求记录](long-sequential.jsonl)
