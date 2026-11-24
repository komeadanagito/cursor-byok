# Rust 检索漏召回归因与跨语料验收

> 历史范围：本文记录 2026-11-21 一轮。“保留版”指当时的实现（快照 v8），之后已有两轮改动，见[独立留出复测](results/2026-11-22/search-proof/README.md)（v9）和[六道行为题跟进](results/2026-11-22/six-followup/README.md)（v10）。两组 RepoQA 自然语言题的前十依次为：原六仓库 29→30→38/60，新六仓库 32→33→36/60。

这轮先诊断 RepoQA，再以不同仓库、不同题源和完整工作树验收。生产实现不读取题目、答案或数据集名。所有评分都离线完成，未调用模型。

## 原始 27 道共同漏召回

这是上一轮 Rust 和实际 Python Semble MCP 均未进入前十的 27 道自然语言题。审计直接读取 Rust 已持久化快照。逐题记录包含仓库提交、题号、定义行、符号表状态和扩大候选池后的排名。[改前记录](results/2026-11-21/rust-miss-audit/before.jsonl) · [改后记录](results/2026-11-21/rust-miss-audit/after.jsonl)

- 27/27 的目标文件都在 Rust 索引里，27/27 的定义行都有标准分块覆盖。
- 扩大 `top_k` 到 100 后，15 个目标块出现在第 16–99 位。另 12 个在这个预算下仍没出现，但 27 个目标文件都至少出现过其他块。扩大 `top_k` 同时改变了检索候选池，不能把这个诊断当成正常前十成绩。
- 13 个目标函数没进入符号表：C++ 6、Java 4、Go 3。缺符号标记不是另一个互斥的漏题分类；它可能影响候选提升，但不是每题漏召回的充分解释。

## 保留的实现

- 分块和函数名索引共享同一份 Tree-sitter 语法树。识别 C/C++ 带类型的定义、Go receiver 方法、Java 方法和构造器，将符号挂回含定义名称的源码块。快照格式从 7 升到 8，需重建一次。两组 RepoQA 的快照合计各增加 2.2% 和 2.9%。
- 同证据分数下，文件级聚合与同分顺序不再依赖哈希表遍历。
- 向量候选只排序需要的 Top-K。完整 React 索引有 45,275 个代码块，在同一份快照上交替运行新旧实现，各计时 120 次，前十的路径和行区间逐次一致。P50 从 8.06 ms 降到 7.18 ms（约 11%），P95 从 9.53 ms 降到 8.76 ms（约 8%）。这是本机热索引查询时延。[计时结果](results/2026-11-21/rust-miss-audit/top-k-perf.json)

## 结果

| 自然语言任务 | 改前前五 / 前十 | 保留版前五 / 前十 |
|---|---:|---:|
| 原 RepoQA 六仓库 | 20 / 26（60 题） | 17 / 29 |
| 新 RepoQA 六仓库 | 19 / 33（60 题） | 18 / 32 |
| 完整 React / Vue | 19 / 19（20 题） | 19 / 19 |
| CoSQA Python 片段 | 75 / 132（200 题） | 75 / 132 |
| CodeSearchNet PHP 片段 | 96 / 185（200 题） | 96 / 185 |
| CodeSearchNet Ruby 片段 | 75 / 156（200 题） | 75 / 156 |

精确函数名在两个 RepoQA 集合里，前十分别从 53/60 和 53/60 提高到 60/60。完整 React/Vue 的符号与字面查询仍各为 20/20。原题里 Rust 与 Semble 共同漏掉的题由 27 道变成 23 道。剩余 23 道的目标符号都已入表，扩大候选池后 14 道进入前 100，9 道仍漏。**自然语言召回仍未达到跨语料提升的验收目标。**

固定分配正文候选和推断符号的实验已撤回。部分片段集的前五上升，完整 React/Vue 前五从 19/20 降到 11/20。下一项候选是把函数名、所属类型和签名纳入函数体分块的表示，优先验证长函数的定义定位。

## 数据与复跑

- RepoQA 使用已记录的固定发布包和校验值。留出仓库是 Marshmallow、Log4cxx、Gson、Express、Nom、Caddy，分别覆盖 Python、C++、Java、JavaScript、Rust、Go。每仓库 10 道题，分别按自然语言和函数名查询；必须覆盖官方定义行。
- 完整 React / Vue 使用 [既有基准的固定提交与实现位置](../semble/README.md)，不与 RepoQA 的分数混算。
- [CoIR CoSQA](https://huggingface.co/datasets/CoIR-Retrieval/cosqa/tree/0846fa3b963a21bead36e9fab61451fc83b777a6) 和 [CoIR CodeSearchNet](https://huggingface.co/datasets/CoIR-Retrieval/codesearchnet/tree/25e0292562b7bee26dd9b2d83a03981795862c77) 使用测试集正标签。每语言按 ID 哈希固定挑 200 道正例查询，同一索引纳入 200 个正例和 2,000 个同语言干扰片段。PHP/Ruby 反转原始 code-to-text 配对以测 text-to-code。按正例片段文件判分，这比真实仓库定义行定位更宽松，不能冒充官方全量榜单。

```sh
cargo build --release -p semble-benchmark --example repoqa-query
python3 support/benchmarks/repoqa/miss_audit.py \
  --rust-run "$rust_run" --mcp-run "$mcp_run" \
  --rust-query target/release/examples/repoqa-query --out "$new_audit_dir"
uv run --script support/benchmarks/repoqa/coir_subset.py \
  --queries "$queries_parquet" --corpus "$corpus_parquet" --qrels "$test_parquet" \
  --language py --rust-query target/release/examples/repoqa-query \
  --model-dir "$pinned_model_dir" --out "$new_coir_dir"
```

PHP/Ruby 用 `--language php` 或 `--language rb`，加 `--reverse-qrels`，并用上游的 `*-corpus` 作为文本查询、`*-queries` 作为代码库。报告中自动记录输入 SHA‑256。RepoQA 留出集用 `benchmark.py --retrieval-only --repos marshmallow-code/marshmallow apache/logging-log4cxx google/gson expressjs/express rust-bakery/nom caddyserver/caddy`。
