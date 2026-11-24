# 公开搜索评测与协议缓存

用固定发布的 RepoQA 检索源码，用 Google FRAMES 的标注链接检验网页搜索证据。复跑只会打开公开语料和评测输出目录，不读取 Cursor 会话、配置、规则或数据库。

```text
support/benchmarks/
├── repoqa/
│   ├── benchmark.py     从 RepoQA 发布包重建源码，跑检索和协议缓存对照
│   ├── upstream.py      调用上游 Semble 的索引与检索 API
│   ├── web.py           用同一个 SWE‑2 查询对照三个网页搜索执行器
│   ├── workspace_mcp.py 按扩展注册参数启动实际 Semble 和 Serena，验收检索与恢复
│   ├── test_benchmark.py  验证评分与协议用量的计算规则
│   └── results/         保留正式跑分的配置、汇总与逐题结果
└── semble/examples/repoqa-query.rs  通过 JSONL 调用 BYOK Rust 索引
server/examples/web-search-bench.rs  通过 JSONL 调用内置网页聚合器
```

## 数据与评分

| 评测 | 数据 | 评分 |
|---|---|---|
| 源码检索 | RepoQA `2024-06-23` 中 Black、uvw、Retrofit、Axios、Tracing、fzf 的发布语料，六个仓库各 10 个原题 | 保留完整自然语言描述，再以发布包标注的符号名跑第二条轨道。用原始 UTF‑8 字节范围确定定义行。返回的路径和代码块覆盖定义行才算命中。 |
| 模型定位 | 每个仓库按发布顺序取第 0 道题，四个模型与协议组合使用同一份 Rust 候选 | 提供前五个带行号的片段，每个最多 80 行。模型须选择有效候选，并给出正确的定义行。候选没覆盖目标时计为整条链路未定位。 |
| 网页搜索 | Google FRAMES 固定 revision 的第 0–5 行，使用官方标注的 Wikipedia 页 | SWE‑2 把原题转成一条查询，所有执行器复用。比较前十条结果覆盖的官方证据，忽略 Wikipedia 移动域名、标题编码和锚点，`curid` 通过 Wikipedia API 解析。 |

RepoQA 的官方任务要求从长源码上下文直接抽取完整函数，并以函数代码相似度计分。这里依赖它的源码和发布标注，并按检索系统的定义行覆盖率计分。FRAMES 的原任务还要读取证据和回答多跳问题，这里只评分首轮搜索返回的证据。完整赛制和全部题目见上游。[RepoQA](https://github.com/evalplus/RepoQA) · [FRAMES](https://huggingface.co/datasets/google/frames-benchmark)

## 模型与缓存

| 接口 | 模型 |
|---|---|
| `/v1/messages` | `devin/swe-2` |
| `/v1/chat/completions` | `devin/swe-2` |
| `/v1/responses` | `devin/swe-2`、`codex/gpt-6.2-sol` |

每个组合、每个仓库跑三次。`cold` 将唯一随机标识放在系统提示开头，随后放同仓库的固定公开源码前缀及原题。`append` 保持首轮消息和系统提示，追加实际首轮回答和复核请求。`changed` 复用 `append` 的历史，仅替换系统开头的标识。每组三次顺序发送。独立组合默认并行度为 2。Messages 在系统块声明 `ephemeral`，OpenAI 形状使用每组稳定的 `prompt_cache_key`。

- **请求命中率**按 `cached > 0` 的请求数除以报告缓存字段的请求数计算。另报告成功响应数和缓存字段覆盖数。
- **缓存 token 占比**按 `Σcached / Σinput` 计算。Messages 分母含普通输入、缓存读取和缓存创建。Chat Completions 与 Responses 总输入字段已经含缓存输入。缺少读写字段保留 `null`。冷请求命中的网关公共前缀会保留在原始统计里。
- 请求直接进入本机 Magpie 的三个 HTTP 接口。记录整次非流式响应时间及原始 `usage`。同模型可以横比三个协议入口，Sol 的结果还受模型和上游路由影响。此实验不测 Cursor Agent 会话恢复之后的缓存，也不测流式首 token。

连续流式对照可用 `cache_continuation.py --protocols messages chat/completions responses`。每种协议分别跑无亲和和同会话亲和两组，报告输入 Token 缓存占比、达到 95% 的续轮数、首段正文及结束耗时。用 `--context-chars 250000 --repos psf/black --rounds 5 --workers 1` 复测长上下文。它直接调用 Magpie，不经过 Cursor 对话恢复和 BYOK 历史投影。

## 复跑

在仓库根执行。`uv` 用于创建独立的上游 Python 环境。Rust 和 Python 共用固定模型权重和 tokenizer。下载的数据文件在运行前校验 SHA‑256。

```bash
bench_dir="$PWD/target/public-search-bench"
mkdir -p "$bench_dir/model"
curl -fL 'https://github.com/evalplus/repoqa_release/releases/download/2024-06-23/repoqa-2024-06-23.json.gz' \
  -o "$bench_dir/repoqa-2024-06-23.json.gz"
curl -fL 'https://huggingface.co/datasets/google/frames-benchmark/resolve/58d9fb6330f3ab1316d1eca12e5e8ef23dcc22ef/test.tsv' \
  -o "$bench_dir/frames.tsv"
model_root='https://huggingface.co/minishlab/potion-code-16M-v2/resolve/e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b'
for filename in config.json model.safetensors tokenizer.json; do
  curl -fL "$model_root/$filename" -o "$bench_dir/model/$filename"
done
uv venv --python 3.12 "$bench_dir/venv"
uv pip install --python "$bench_dir/venv/bin/python" \
  'git+https://github.com/MinishLab/semble.git@a1ba6c18a4b0a58a3d1a15217d64bc92678d1d9d'
cargo build --release -p semble-benchmark --example repoqa-query
HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false python3 support/benchmarks/repoqa/benchmark.py \
  --dataset "$bench_dir/repoqa-2024-06-23.json.gz" \
  --rust-query target/release/examples/repoqa-query \
  --upstream-python "$bench_dir/venv/bin/python" \
  --model-dir "$bench_dir/model" \
  --out "$bench_dir/repoqa-run-01"
```

默认调用 `127.0.0.1:3425` 上的 Magpie，总计 72 次请求。只跑源码检索可加 `--retrieval-only`，用三个新的输出目录各跑一次即可复测冷建和重启回载的中位数。通过兼容的模型网关复跑可传 `--base-url` 和环境变量 `REPOQA_API_KEY`。为每次复跑指定新目录。

```bash
cargo build -p cursor-server --example web-search-bench
cp target/debug/examples/web-search-bench "$bench_dir/web-current"
mkdir "$bench_dir/baseline"
git archive 7fded59 | tar -x -C "$bench_dir/baseline"
mkdir -p "$bench_dir/baseline/server/examples"
cp server/examples/web-search-bench.rs "$bench_dir/baseline/server/examples/"
CARGO_TARGET_DIR="$PWD/target" cargo build --manifest-path "$bench_dir/baseline/Cargo.toml" \
  -p cursor-server --example web-search-bench
cp target/debug/examples/web-search-bench "$bench_dir/web-1.0.6"
python3 support/benchmarks/repoqa/web.py --dataset "$bench_dir/frames.tsv" \
  --baseline "$bench_dir/web-1.0.6" --current "$bench_dir/web-current" \
  --out "$bench_dir/frames-run-01"
```

网页评测包含 6 次 SWE‑2 查询改写。旧版和当前版使用各自的实际搜索代码，Exa 使用公开匿名 MCP。每道题交替执行顺序，搜索耗时不包含查询改写及事后的链接规范化。网络时延和搜索源排序会变化，重复实验需要记录日期和运行位置。Exa 如拒绝匿名初始化，两版聚合器仍完成对照，Exa 记录为不可用。

### 工作区 MCP

在工作区主机安装 Semble `0.7.3` 的 `mcp` extra 和 Serena `2.1.0`。取 [scip-typescript 固定提交](https://github.com/sourcegraph/scip-typescript/tree/7f51391d9770c63be2449463c8eb89f98c9e1468/snapshots) 的 `snapshots/input/syntax` 和 `snapshots/output/syntax`。沿用上面下载的 RepoQA 和模型文件。

```bash
uv tool install 'semble[mcp]==0.7.3'
uv tool install -p 3.13 serena-agent==2.1.0
SERENA_HOME="$bench_dir/serena-home" python3 -m support.benchmarks.repoqa.workspace_mcp \
  --dataset "$bench_dir/repoqa-2024-06-23.json.gz" \
  --model "$bench_dir/model" --scip "$bench_dir/scip-typescript/snapshots" \
  --serena "$(command -v serena)" --semble "$(command -v semble)" \
  --out "$bench_dir/workspace-mcp-01"
```

脚本调用扩展的注册函数，再按注册参数启动真实进程。Semble 使用本地模型。首次运行 Serena 可能安装 TypeScript 语言服务器。`report.json` 含 MCP 注册至发现耗时、语义首查与重启首查、符号工具回包和故障恢复结果。`retrieval.jsonl` 含六仓库描述题及同题符号名查询的逐题候选。该脚本使用独立的索引目录，每次给新的 `--out`。首次建索引不包含下载模型的耗时。分支用例会在临时 Git 仓库替换文件，测量旧结果消失、新定义出现，以及重启后复用索引的时间；不连接 SSH 主机。

[工作区 MCP 验收报告](results/2026-11-21/workspace-mcp/README.md)

## 复跑索引互补与 BYOK 长续轮

用实际 MCP 输出和 Rust 候选，按相同的前五、前十预算对照。不把候选并集当作前十成绩。

```bash
python3 support/benchmarks/repoqa/hybrid_retrieval.py \
  --rust "$bench_dir/repoqa-run-01/retrieval.jsonl" \
  --mcp "$bench_dir/workspace-mcp-01/retrieval.jsonl"
python3 support/benchmarks/repoqa/adapter_workloads.py \
  --dataset "$bench_dir/repoqa-2024-06-23.json.gz" \
  --retrieval "$bench_dir/repoqa-run-01/retrieval.jsonl" \
  --out "$bench_dir/tool-continuation"
cargo build -p cursor-server --example repo-cache-bench
for protocol in messages chat/completions responses; do
  target/debug/examples/repo-cache-bench "$protocol" \
    < "$bench_dir/tool-continuation/workloads.jsonl" > "$bench_dir/tool-continuation/${protocol##*/}.jsonl"
done
```

此流程由生产协议适配器流式调用本机 Magpie 的 SWE‑2，回填真实公开源码；不启动 Cursor 会话，不读取用户工作区。网页回归可以传 `--queries-from` 重用早先的 `web.jsonl`，以 `--start 6 --count 6` 另跑留出集，或用 `--searxng-url` 加入启用 JSON 的自建实例。见[本轮复测结论](recall-and-cache-followup.md)。

[Rust 检索漏召回归因与跨语料验收](rust-miss-audit.md) 记录逐题审计的复跑方法、独立仓库和片段集的结果，以及完整 React 索引上的查询时延。另见[完整 React/Vue 的独立留出与交替对照](results/2026-11-22/search-proof/README.md)，包括冻结标签、二进制指纹和原始样本。

## 输出

`config.json` 记录数据包版本、SHA‑256、工作环境、Rust 二进制哈希和各仓库提交。`retrieval.jsonl` 含每题排名、耗时和结果区间，`model.jsonl` 含每个模型请求的阶段、用量、候选、答案和判分，`web.jsonl` 含 FRAMES 问题、改写查询、搜索结果和官方证据。两个 `summary.json` 分别汇总源码与网页结果。比较版本请保留逐题 JSONL，并使用相同的二进制编译配置、数据切片和并发数。

[2026‑11‑21 完整报告及原始记录](results/2026-11-21/README.md) · [SWE‑2 连续会话缓存与 pi 对照](results/2026-11-21/swe-cache/README.md)
