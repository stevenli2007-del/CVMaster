# ADR-003：文件/网页解析的执行方式、队列、重试、限制与数据保留

状态：Proposed（待 Steven 与 Codex 审阅）
日期：2026-11-25
关联：[CP3 总体设计](../design/CP3-ai-extraction-evidence-design.md)、[ADR-004](ADR-004-ai-provider-output-schema.md)

## 背景

CP2 只把链接作为文本保存、把文件上传到 private Storage；没有抓取、解析或 AI。现有 4 MiB 文件限制和 server-managed delete 必须保留。CP3 会把不可信网页和文件带入服务端，再生成需要长期可追溯的证据，因此不能把抓取/解析塞进入站请求，也不能只靠同步 Vercel `waitUntil` 保证完成。

## 推荐方案

采用**持久 queue + 独立受限 worker + 不可变 material revisions/segments**。抓取和文件解析不接触 BYOK；模型提取只读取通过校验的规范化文本。

### 1. 执行拓扑

```text
Authenticated app request
  → 创建 material / immutable revision
  → transaction 写 processing_jobs + enqueue（消息仅 job UUID）
  → scheduler 唤醒 worker（同时保留周期 poll 作为恢复）
  → worker lease job，重新校验 owner、revision、生命周期和配额
  → fetch/parse sandbox 产出规范化 segments + hash + locator
  → transaction 提交 parse 结果
  → 用户 preview/consent 后才允许独立 extraction job 调 provider
```

- 推荐 Supabase Queues（pgmq）承担持久投递，`processing_jobs` 承担用户可见状态、幂等、lease 和业务审计。queue archive 不保存素材、密钥、完整 URL query 或模型文本。
- 调度推荐 Supabase Cron + 受保护的 worker HTTP 入口；worker secret 只存在服务端 secret store。立即唤醒只是降低延迟，周期 poll 才是崩溃恢复保证。
- worker 部署为与主 Next.js 进程隔离的受限运行单元。文件 parser 无 BYOK/KEK、无 service role、无出站网络，只收到单 job 所需的只读输入和受限写回能力。
- fetch worker 需要网络，但必须由环境 egress policy 配合应用校验；不能仅靠 `new URL()` 检查。模型请求只能由独立 extraction orchestrator 发出。
- 具体 worker 托管平台仍待 Steven 选择；若平台无法提供网络隔离、资源硬限制和临时数据清理，对应文件/URL 类型不得上线。

### 2. 为什么是 revision + segment

- note 编辑、网页重新抓取或文件替换会创建新 revision，不能原地覆盖旧证据所指向的内容。
- `materials` 保留 CP2 当前来源字段和 UI 兼容；`current_revision_id` 是 CP3 处理指针。更新当前字段和创建 revision 必须同事务，避免双写分叉。
- 已有 CP2 materials 采用增量 backfill：首次 CP3 处理时创建 revision；新数据直接创建。无需为所有历史文件一次性下载/ hash，避免大迁移。
- parser 输出固定顺序 segments，记录文本、hash、sequence 和原始定位信息（PDF page、DOCX paragraph、HTML text path/offsets 等）。证据永远指向 `(revision_id, segment_id)`。
- 重新解析或重提取不会覆盖旧 run/claims；新结果先为 pending，用户明确处理旧 claims 的 supersede 关系。

## 首个解析矩阵

推荐先用最小可验证集合，不因 CP2 能上传就承诺都能 AI 提取。

| 类型 | CP3 推荐 | 说明 |
|---|---|---|
| note | 支持 | 使用用户原文建 revision，保留字符 offsets |
| 公开 Web/GitHub HTML | 支持 | 仅静态 HTTP(S) 内容提取；不登录、不绕 paywall、不执行页面脚本 |
| TXT / Markdown / CSV | 支持 | 有界解码；不把 Markdown/HTML 当可信可执行内容 |
| PDF | 支持文字层 | 不执行 JS/embedded files；扫描 PDF 返回 `needs_user_input`，不隐式调用 OCR |
| DOCX | 支持文字与段落 | 禁宏、禁外部 relationship/XXE；限制 ZIP 展开 |
| DOC（legacy binary） | 首个切片不支持 | 需要额外解析器/隔离验证；保留原文件，引导用户转 DOCX/PDF/note |
| PNG/JPG/WebP/GIF、voice | 首个切片不提取 | 保留 CP2 上传能力；OCR/转写需另选 provider、隐私与成本决策 |

不支持的类型是明确的 `unsupported/needs_user_input`，不能静默标记提取完成。

## 队列、幂等与失败恢复

### Job 分类

`fetch_web`、`parse_file`、`normalize_note`、`extract_claims`、`delete_material`、`delete_experience`、`delete_account`、`reap_temporary_data`。删除 job 的协调语义见 CP3 总体设计。

### 原子与幂等

1. enqueue 使用业务幂等键，例如 `parse:revision_id:parser_version`、`extract:consent_id:payload_hash`；同一活动 job 唯一。
2. pgmq 的可见性交付不是端到端 exactly-once。worker 每次提交都用 job attempt/lease token 和 revision hash 做条件更新。
3. claims、evidence、run 状态在一个 DB transaction 中写入，run-local claim ID 有唯一约束；重复 delivery 的第二轮应为 `created=0/updated=0`。
4. worker 在 lease 内 heartbeat；过期 job 可被其他 worker 接管。过期 worker 的迟到提交必须失败。
5. worker 在 provider 成功后、DB 提交前崩溃时，若没有 provider 幂等/查询能力，run 标 `outcome_unknown`，由用户确认后重试；不得自动再次计费。
6. 删除或替换素材后，提交前再次检查生命周期和 current revision；迟到结果不得附着到新 revision。

### 重试分级

| 失败 | 自动策略 | 用户策略 |
|---|---|---|
| queue/worker 崩溃、lease 丢失 | 最多 3 次，30 s / 5 min / 30 min + jitter | 超过后显示 failed，可手动重试 |
| 抓取网络临时错误、429、5xx | 最多 2 次额外尝试；尊重有界 Retry-After | 最终失败保留 URL，可重试或改 note |
| provider 网络/429/5xx | 仅在请求幂等可保证时最多 1 次自动重试 | 否则 `outcome_unknown`；用户明确重试 |
| 文件格式不支持、SSRF、恶意/超限、4xx 授权错误 | 不自动重试 | 修正输入/key/scope 后新建 attempt |
| JSON/schema/evidence 校验失败 | 默认不自动“让模型修复”，避免隐藏成本 | run 显示 partial/failed；用户可发起新 run |

任何自动 provider 重试都必须在 consent preview 的次数和预算内。指数退避不能造成超过保留期的无限 queue archive。

## 推荐初始限制

以下是工程默认值提案，不是用户已批准的产品套餐；实现时集中在版本化配置，并在 UI 显示实际限制。

| 项目 | 推荐初始上限 |
|---|---|
| 上传文件 | 延续 CP2：单文件 4 MiB、每批 5 个；magic bytes 与声明 MIME 必须一致 |
| note | 延续 CP2：20,000 字符 |
| URL | 最长 2,048；仅 http/https；仅 80/443；无 userinfo；最多 3 次 redirects |
| Web 下载 | 连接 5 s、总请求 20 s；流式上限 2 MiB，解压/解码后同样设硬上限 |
| Web 正文 | 仅 text/html（必要时 text/plain）；规范化文本最多 100,000 字符，超出要求用户选取范围，不静默截断 |
| 文件展开 | DOCX 最多 2,000 entries、总展开 20 MiB、单 entry 8 MiB、压缩比 20×；超限拒绝 |
| PDF | 最多 100 页；无文字层时返回 needs user input |
| 规范化文本 | 单 revision 最多 120,000 字符；segment 目标 8,000、最大 12,000 字符；最多 12 segments |
| parser | 15 s CPU / 30 s wall / 256 MiB memory / 独立临时目录；平台硬限制优先于应用计时器 |
| 单次 extraction | 只发送用户选中的 segments；输入 token 和输出 token 分别设 model profile 上限，初始输出上限 4,096 tokens |
| provider 请求 | 60 s 总超时；不在前台页面请求里等待；usage 超过 consent 预算即停止后续 chunks |
| 并发/配额 | 初始每用户 1 个 active parse + 1 个 active provider request，全局 worker 有界并发；账户日/月预算待确认 |

字符上限用于资源控制，token 上限用于模型成本控制，两者不能互相替代。若内容超限，系统展示需要缩小范围，不悄悄只处理前半份并宣称全量完成。

## SSRF 与恶意网页防护

1. 解析并 canonicalize URL；拒绝 userinfo、非 HTTP(S)、非允许端口和隐晦 IP 表示。fragment 不发送；query 可能含敏感 token，preview 要展示且默认不发送给模型。
2. 对初始 URL 和**每一次 redirect**重新解析所有 A/AAAA，仅允许全局可路由 unicast 地址；拒绝 loopback、私网、link-local、metadata、multicast、保留/文档段、IPv4-mapped IPv6 绕过及其他非全局地址。
3. DNS 校验后将连接固定到已验证 IP，同时保持正确 Host/SNI，防 DNS rebinding；连接层 egress firewall 再阻断私网/metadata。
4. 不携带用户 cookie、Authorization、浏览器 proxy credentials 或环境代理；不响应远端 401 认证挑战，不访问私有仓库。
5. 限制 redirect、端口、响应 bytes、decompression、MIME、时间和每 host/账户速率。响应即使声明 HTML 也按不可信数据处理。
6. 首个切片不运行 headless browser、不执行 JS、不加载子资源、不抓取模型输出给出的 URL。登录墙/paywall/robots 不允许时直接失败并提供 note/file 替代。
7. 推荐默认尊重 robots.txt 和站点条款；是否把它作为硬阻断需 Steven 确认产品政策。无论如何不实现反爬绕过。
8. HTML 只抽取正文和稳定 locator；脚本、style、iframe、form、event handler 不进入 segments。UI 永远转义来源和模型文本。

## 恶意文件与模型输入防护

- 魔数、扩展名和 MIME 交叉验证；失败只返回安全错误码。用户文件名从不作为服务器路径。
- parser 运行在无 secret、无网络、只读输入、独立临时目录和低权限身份下；不执行宏、嵌入对象、PDF action 或外部命令。
- DOCX 禁 DTD/XXE 和外部 relationships；ZIP 逐项限额。PDF 不跟随嵌入 URL，不渲染任意脚本。
- 临时输入在成功、失败和超时路径都清理；worker crash 由临时容器销毁和周期 janitor 双保险。
- 防病毒扫描可作后续 defense-in-depth，但不能替代隔离和资源限制。
- 素材内“忽略规则、发送其他文件、修改 schema”等文字都是数据而非指令。extraction 无工具调用、无网络能力、无其他素材上下文；模型输出不能控制路径、URL、SQL、命令或 job 类型。

## 数据保留与删除

| 数据 | 推荐保留 | 删除行为 |
|---|---|---|
| 用户 note、原始上传文件 | 直到用户删除素材/经历/账户 | 通过 deletion job 删除 DB 与 private object |
| Web 原始 HTML/压缩响应 | 默认不持久化；仅在 worker 临时区完成解析 | parse 后立刻清理；失败也不写入通用日志 |
| Web 规范化正文与 fetch metadata | 保留支持当前证据所需的 revision/segments；记录 final URL、fetch time、hash、安全响应 metadata | 素材删除时级联；无人引用的 superseded revision 在重提取完成后删除 |
| 文件/note 的规范化 segments | 与对应 revision 和 claims 同生命周期 | 不再被 run/claim/evidence 引用时删除 |
| 原始模型输出 | 默认不保存 | 内存中校验后丢弃；禁止写入错误日志 |
| 结构化 claims/evidence/run/consent | 保留至用户删除来源或删除相应派生数据 | 同事务级联；rejected claim 也只有用户删除后才移除 |
| processing/queue 记录 | 只含 UUID、状态、计数和安全错误码；完成 metadata 建议 30 天后清理 | 活动删除 job 保留至完成；queue archive 建议 7 天，待确认 |
| 临时文件 | job 结束即删，janitor 兜底最长 1 小时 | 超时/崩溃也清理，不进入备份 |
| 应用日志/指标 | 只保留 ID 的受控子集、状态、延迟、token/成本计数；建议 30 天 | 不含正文、URL query、key、模型文本；按批准周期清理 |

备份不是即时删除例外之外的“隐形回收站”。需要记录 Supabase/Vercel/worker/provider 各自保留与备份周期，并在隐私说明中区分“在线数据立即不可见”“本地备份到期清除”“provider 副本受其政策约束”。

部分失败必须保留可重试 deletion job；不得因为 Storage 成功、DB 失败就放弃剩余 claims/evidence，也不得重新开放客户端 delete policy 绕过协调。

## 备选方案与取舍

| 方案 | 优点 | 代价/风险 | 结论 |
|---|---|---|---|
| A. Supabase Queues + 独立受限 worker（推荐） | 复用 Postgres、持久恢复、主服务隔离、适配后续 OCR | 新 worker 托管与调度运维；需验证 exactly-once 业务提交 | 推荐 |
| B. 全部在 Vercel 同步 Function + waitUntil | 部署最少、开发快 | 无可靠队列/重试；不可信解析和 SSRF 与主服务同边界；超时后任务可丢 | 不接受用于完整 CP3 |
| C. Vercel Workflows/Queues + Sandbox | 同平台、持久步骤和隔离潜力 | 新依赖/费用/功能限制需 spike；仍需证明 egress、临时文件和 provider 幂等 | 可作为 A 的托管实现，须先验证 |
| D. 第三方托管解析/OCR API | 文件覆盖广、实现快 | 素材在用户 consent 前就可能进入新第三方；隐私/DPA/区域/成本增加 | 首个切片不采用，后续单独 ADR/consent |
| E. 自研 job 表，不用 pgmq | 无扩展依赖、逻辑直观 | 容易遗漏锁、lease、归档和调度边界 | 若 Supabase Queues 不可用才降级，仍需同等测试 |

## 主要风险

- **平台只有应用层 URL 检查，无 egress 防 rebinding**：不得上线 URL 抓取。
- **serverless 临时盘/实例复用残留**：必须验证隔离和清理，不把“实例通常会销毁”当证据。
- **重试重复计费**：provider attempt ledger + 幂等 + `outcome_unknown`；不能仅依赖 job 状态。
- **证据随网页变化失效**：revision hash、fetch time、规范化正文保留；不声称后续网页仍含同样内容。
- **保留过多内容方便调试**：默认不存 raw HTML/raw model output；调试使用合成 fixtures。
- **类型范围膨胀**：OCR、voice、legacy DOC 和私有 GitHub 都必须重新审阅，不在 CP3 偷渡。

## 待用户确认

1. worker 选择独立容器、Vercel Sandbox/Workflow，还是其他托管？部署区域、预算与运维归属是什么？
2. 首个切片是否接受不支持图片 OCR、voice、legacy DOC，扫描 PDF 只提示补充文本？
3. 是否默认尊重 robots.txt 并只支持静态公开 HTML，不执行 JS、不支持登录墙？
4. Web 原始 HTML 默认不持久化是否接受？若为证据复核需要保留，需另定加密 Storage、周期和成本。
5. 上述大小/页数/segment/token/超时/重试/并发默认值及用户日/月预算是否接受？
6. queue archive、完成 job metadata、日志、临时文件、备份和未引用 revisions 的具体保留期限。
7. superseded claims 的 UX：推荐保留旧 evidence 直至用户选择替换/删除，不自动把旧 confirmed 状态迁移到新 AI 输出。

## 官方参考

- [Supabase Queues](https://www.supabase.com/docs/guides/queues)：Postgres/pgmq 持久队列与可见性交付。
- [Supabase Cron](https://www.supabase.com/docs/guides/cron)：周期 SQL/HTTP 调度。
- [Vercel background workers](https://vercel.com/kb/guide/background-workers-on-vercel)：`waitUntil` 不提供持久 queue/retry；长任务需要持久编排。
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)：实际 duration/memory/body limits 必须在实现时按项目 plan 复核。
