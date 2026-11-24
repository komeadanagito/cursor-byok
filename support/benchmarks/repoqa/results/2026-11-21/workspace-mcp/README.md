# 工作区搜索 MCP 验收 · 2026-11-21

在 macOS ARM64 上调用工作区扩展的注册入口，按返回的命令和参数启动 Semble 0.7.3 与 Serena 2.1.0。两项服务分别经过 MCP 初始化、工具发现和实际工具调用。语义模型使用固定版本的 `potion-code-16M-v2` 本地权重，Serena 使用已安装的 TypeScript 语言服务器。

## 语义检索

| RepoQA 轨道 | 前 5 命中 | 前 10 命中 | 热查询 P50 |
|---|---:|---:|---:|
| 任务描述 | 18/60 | 26/60 | 2.37 ms |
| 符号名关键词 | 46/60 | 49/60 | 2.89 ms |

命中要求文件路径与块行号覆盖 RepoQA 标注的函数定义。自然语言查询命中第 1 位的例子包括 Black 的 `src/black/ranges.py:128`、Retrofit 的 `OkHttpCall.java:93` 和 fzf 的 `src/options.go:249`。完整候选包含漏检样本。[逐题结果](retrieval.jsonl)

六个仓库的 stdio 握手与发现 P50 为 332 ms，进程存活期间的首次查询及冷建索引 P50 为 231 ms。关闭后用原索引目录重启，首次查询 P50 为 140 ms，六个仓库的首题候选顺序一致。上述时间按阶段记录，首次模型下载、模型生成和 SSH 网络耗时均未纳入。[握手、重启和回包记录](report.json)

## LSP 符号查询

以 Sourcegraph `scip-typescript` 固定提交的 `syntax` fixture 为准。表内用源码的一起始行号，Serena 回包保留零起始行号。

| 工具 | 实测结果 | 单次耗时 |
|---|---|---:|
| 符号概览 | `src/import.ts` 返回 `dynamicImport`、`useEverything` | 137 ms |
| 查定义 | `newFunction` → `src/function.ts:1` | 103 ms |
| 查引用 | `src/import.ts:4、12、18`，分别覆盖 import、普通调用和动态导入 | 319 ms |
| 查实现 | `src/inheritance.ts:30、39`，另有对象字面量和调用签名夹具的结果 | 133 ms |

查询不存在的符号得到空列表，重启 Serena 后定义位置一致。用不存在的模型目录启动 Semble 后，索引调用返回 `isError: true`，同一工作区的 Serena 四项查询仍成功。用有效模型目录重启 Semble，`search` 与 `find_related` 恢复。该故障用例覆盖独立失效与重新启动恢复。

## Cursor 与网页搜索复测

Cursor 3.31.15 在隔离配置里成功安装、激活扩展，并注册两个工作区 MCP。该窗口停在登录页，两项连接返回 `unauthenticated`。单独用同版本内置的 Cursor Helper (Plugin) 运行语义桥，成功发现两个工具，首位结果为 `src/function.ts:1`。实际 Agent 工具调用与 SSH 主机仍待验收。

Cursor 给工具加上扩展和工作区前缀。BYOK 将超过 64 字符的工具名映射为确定的短名，调用回 Cursor 时保留原路由。用公开 TypeScript 夹具单独验收供应商接口，SWE‑2 的 Messages、Chat Completions 和 GPT‑6.2 Sol 的 Responses 都返回 HTTP 200，并输出同一工具名和准确的引用查询参数。[三接口实测回执](provider-tools.json)

固定 Google FRAMES 六题重新用 SWE‑2 改写，每题的两个内置聚合版本和匿名 Exa 采用同一查询。在首轮前十结果里，1.0.6、当前版和匿名 Exa 分别覆盖 2/20、1/20、2/20 条标注链接，耗时 P50 为 6.28 s、4.00 s、0.97 s。六题只能描述这次样本，当前版的耗时下降伴随少命中一条链接。[网页搜索原始记录](../frames-review/web.jsonl) · [复跑说明](../../../README.md)
