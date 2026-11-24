# 独立留出复测：Rust 代码检索

> 历史范围：本文记录 2026-11-22 第一轮（快照 v9）。这 24 道冻结题此后被用于诊断剩余的行为题和挑选实现，所以下一轮在这 24 题上的成绩不再是留出成绩，见[六道行为题跟进](../six-followup/README.md)。本文最终版的 384 次样本后来经过独立重算，逐条排名与样本记录一致（[重算结果](../six-followup/recount.json)）；下一轮另做了一次独立重算（[verified.json](../six-followup/verified.json)）。

子代理在看到检索输出之前冻结了 24 道新题及源码真值，不修改产品代码。React 和 Vue 各 12 道；8 道含符号、8 道使用领域术语、8 道转述可观察行为。所有查询都在完整仓库上定位一个标注的实现行，返回目标文件的其他位置不算命中。题集未因失败而改动。[冻结题集](queries.jsonl) · [SHA‑256](queries.sha256)

React 固定提交 `eafeac097ba51e1eab809c07102126bd5f8e5425`，归档 7,202 个文件，实际索引 4,760 个文件 / 45,275 块；Vue 固定提交 `a2b40db9a83b36ed9da3a16403cf8f040262d73f`，归档 705 个文件，实际索引 554 个文件 / 7,933 块。索引按产品的默认源码过滤规则构建。提交号见既有基准固定配置；归档未携带 `.git`，复跑额外核验 24 个目标文件及冻结声明行。

## 独立性能对照

子代理用提前封存的原版与 BM25 版共用同一 v8 快照。两进程分别预热，按 ABBA / BAAB 串行交错，每道题每版 8 次，共 384 次查询，进程禁网和禁止写入。记录检索 API 内时延，不包含建索引、读取结果正文或 IDE/MCP 往返。BM25 版把稠密文档编号直接用作数组下标，固定浮点评分顺序，并且只排序需要的前 K。24 道题的有序前十全部一致，命中仍为前一 8/24、前五 9/24、前十 13/24。子代理首次实测时共享 release 路径已被 BM25 构建覆盖；后续用哈希锁定的两个文件交替复测，不以首次单轮作为性能证据。

| 完整仓库 | 原版 P50 / P95 | BM25 P50 / P95 | 最终版 P50 / P95（第二组对照） |
|---|---:|---:|---:|
| React | 9.25 / 11.15 ms | 5.08 / 5.61 ms | 5.15 / 5.89 ms（同组原版 9.60 / 11.54 ms） |
| Vue | 1.44 / 1.66 ms | 0.92 / 1.04 ms | 0.94 / 1.08 ms（同组原版 1.47 / 1.69 ms） |

[子代理原始 384 条样本](bm25-samples.jsonl.gz) · [运行清单和指纹](bm25-run.json) · [最终原始 384 条样本](final-samples.jsonl.gz) · [最终运行清单和指纹](final-run.json)

## 召回对照与代价

最终版把完全处于同一函数体的检索命中作为该函数声明的证据，按 AST 字节范围判断归属，不按文件名、仓库名或题目调权。精确符号和字面查询不增加这条证据。同样用 24 道冻结题将最终版与原版交替运行：前一 **8→8**、前五 **9→11**、前十 **13→15**。React 仍是 **5/12**，Vue 从 **8→10/12**。两条新增结果在第 4 位，没有原命中掉出前十。8 条行为转述仍只命中 **2/8**。[逐题变化（含失败）](final-comparison.json)

- [旧 React/Vue 回归](byte-full-comparison.json)：自然语言前十保持 19/20，字面和精确符号各保持 20/20。
- RepoQA 原六仓库自然语言前十 [29→30/60](byte-final-dev-comparison.json)，独立六仓库 [32→33/60](byte-final-holdout-comparison.json)。两个集合的精确符号前十仍各 60/60。
- [完整 Requests、Axios、Zod、Axum](full-extra-comparison.json)：80 道既有题，仅按文件评分。在前十个返回块里去重文件再评分；前十仍是 64/80（分仓分别 20、19、11、14/20）。这个数字不与定义行测试混算。
- [冷建与重启回载](cold-results.json)：无持久索引、模型文件已在本地，按 ABBA/BAAB 各测 4 次，A 为 BM25 版、B 为最终版。中位数 React 3.75→3.81 秒，Vue 0.52→0.55 秒；重启回载分别 53.57→53.38 ms 和 11.50→12.05 ms。两仓索引二进制合计 69,828,855→69,987,489 字节（约 +0.23%）。热查询更快，冷建没有提速。v9 索引需重建一次。

结论：性能收益经过交替对照；自然语言只获得有限定位改善，未达到普遍高召回的目标。上面测的是 Rust 检索，不是当前工作区默认 Semble/Serena，也没有与 Cursor 官方结果对照。

## 复跑（macOS）

把固定提交的完整源码分别放到 `$roots/react` 和 `$roots/vuejs`。用 `cargo build --release -p semble-benchmark --example repoqa-query` 构建相应版本后，分别保存 worker，避免共享目标文件被下一次构建覆盖。准备各版本独立的索引目录，放入同一份固定模型（见[上一级基准说明](../../../README.md#复跑)）。先执行对应 worker `"$cache" "$roots/react" "$roots/vuejs" </dev/null` 建索引，再运行：

```bash
python3 -I -B support/benchmarks/repoqa/results/2026-11-22/search-proof/compare.py \
  --repos "$roots" --baseline "$baseline" --baseline-cache "$baseline_cache" \
  --candidate "$candidate" --candidate-cache "$candidate_cache" --out "$new_output"
```

在生成的 `samples.jsonl` 中可逐条核对请求序号、目标排名、路径和行范围；也可用 `gzip -dc` 读取归档的完整样本。运行清单仅将本机绝对目录替换为变量占位符，保留二进制、模型、缓存和题集的原始 SHA‑256。上一次总结前的原版是包含上一轮 Rust 改动的工作树 release，**不是** Git 的 `HEAD`，所以以运行清单中的封存 worker 哈希识别。
