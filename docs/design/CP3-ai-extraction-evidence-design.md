# CP3 前置设计：AI 提取与证据校对

状态：Proposed（待 Steven 与 Codex 审阅；不是实现授权）
基线：CP2 `1193e2310e803e9f3eb9712e55149aee32322ef9`
日期：2026-11-25

## 1. 范围与不变量

本设计只确定 CP3 的数据契约、安全边界和验收路径，不接入 provider、不调用模型、不抓取用户 URL、不解析用户文件，也不新增真实密钥或依赖。

关联 ADR：

- [ADR-001：BYOK 密钥管理](../adr/ADR-001-byok-key-management.md)
- [ADR-003：文件/网页解析、队列与生命周期](../adr/ADR-003-parsing-queue-retention.md)
- [ADR-004：用户自选 provider、协议适配、数据范围与结构化输出](../adr/ADR-004-ai-provider-output-schema.md)

必须延续的 CP2 边界：

1. 浏览器只持有 Supabase 用户会话和公开配置；`SUPABASE_SERVICE_ROLE_KEY`、BYOK KEK、worker 凭证均只存在服务端。
2. Storage 保持 private；不恢复客户端直删 Storage 或业务记录的权限。删除继续由已验证 owner 的服务端流程协调。
3. 所有新表都有 `user_id`、复合 owner 外键、最小 grants 和 RLS；worker 使用高权限客户端时仍显式限定 job 中的 owner 和对象。
4. 原始素材、文件、网页、模型输出和模型返回的错误均按不可信输入处理。
5. AI 只能创建 `origin='ai' + review_state='pending'` 的 claims；确认是独立、带用户身份的服务端操作。推断、缺失提示和置信度都不是用户事实。
6. 采用 provider-neutral / user-selected provider 原则：用户自己选择 provider、API key、model、endpoint 和 protocol。在协议已支持且安全校验通过的前提下，用户选择哪家 API，CVMaster 就调用哪家 API；不设置唯一或默认品牌。
7. provider 配置不等于发送授权。只有用户看过本次发送范围、目标域名和配置并确认后，才可创建允许调用该 endpoint 的 extraction job。更换 provider、model、endpoint、protocol 或 adapter version 必须重新 preview + consent，不做未经同意的跨 provider fallback。

## 2. 对现有文档与 CP2 schema 的检查结论

`docs/DATABASE.md` 目前只有概念上的 `extraction_runs`、`claims`、`ai_credentials`；CP2 实际 migration 只创建 `profiles`、`experiences`、`materials`。因此：

- CP3 会新增实际表和接口，但不需要迁移不存在的生产 claims 或密钥数据。
- 现有 `materials.processing_status='ready'` 对 note、链接和上传文件表示“已入库”，不表示“已解析/已提取”。CP3 不改变这个历史含义，解析状态放到 `material_revisions`，模型状态放到 `extraction_runs`。
- 现有单个 `claims.evidence_quote/evidence_locator` 无法表达一条事实由多个片段共同支持，也无法稳定应对素材修订；需要独立 segments 和 evidence 表。
- 现有 `state='proposed/confirmed/rejected/manual'` 混合了“来源”和“审阅状态”；需要拆分，否则无法可靠地区分手动事实与 AI 事实。
- CP2 删除是同步的“先 Storage、后数据库”。CP3 新增派生数据与异步任务后，需要可恢复的 deletion job，但不能通过重新开放客户端 delete grants 来简化实现。
- CP2 允许 PNG/JPG/WebP/GIF、PDF、TXT/MD/CSV、DOC/DOCX，单文件 4 MiB、每批 5 个。允许上传不等于 CP3 都支持提取；首个解析矩阵见 ADR-003。

## 3. 提议的数据模型变化

以下仅为 migration 设计，不在本阶段创建 SQL。

| 实体/变化 | 关键字段与约束 | 目的 |
|---|---|---|
| `ai_credentials`（新增实际表） | owner/provider/config label/model/规范化 endpoint/protocol/last_four、密文、nonce、wrapped DEK、KEK version、状态和时间；客户端只能读非敏感配置与元数据 | 按 ADR-001 保存密文，绝不保存明文；配置不限定唯一品牌 |
| `material_revisions` | `material_id/user_id/revision_no`、不可变来源引用、`content_hash`、parser/version、`parse_status`、安全错误码 | 让证据绑定到当时的内容，而不是会被编辑覆盖的 material |
| `material_segments` | `revision_id/user_id/sequence`、规范化文本、`source_locator`、hash；owner 复合外键 | 提供稳定证据锚点、分块发送和精确回溯 |
| `processing_jobs` + 私有 queue message | job 类型、owner、target、attempt、lease、idempotency key、安全错误码；消息只含 job UUID | 持久状态、重试和崩溃恢复；queue 中不放素材或密钥 |
| `extraction_consents` | owner、material revision、segment IDs、payload hash、provider/model/endpoint/protocol/adapter version、schema/prompt version、确认时间 | 证明用户同意了哪一次、哪一份数据发往哪个目标 |
| `extraction_runs`（落地并扩展） | consent/revision、credential ID、provider/model/规范化 endpoint/protocol/adapter version、prompt/schema/parser/pipeline versions、状态、usage、request attempts、安全错误码 | 审计、幂等、成本统计和失败恢复；默认不存原始模型文本 |
| `claims`（落地时调整概念模型） | `origin='ai'/'user'`、`review_state='pending'/'confirmed'/'rejected'`、当前文本、run/revision、版本号、确认者/时间 | 分开来源与审阅；AI 不可自行确认 |
| `claim_revisions` | claim、前一文本、新文本、actor、时间 | 用户编辑可审计，不覆盖掉 AI 原提案的历史 |
| `claim_evidence` | claim、segment、run、精确 quote、规范化 offsets、原始 locator、hash；每条 AI claim 至少一条 | 多对多证据引用；服务端验证 quote 与 offsets |
| `deletion_jobs` | owner、target type/id、阶段、待删对象 key、attempt、安全错误码、完成时间 | 覆盖 Storage、queue、派生记录的部分失败重试 |

统一约束：

- 新业务表均 `enable row level security`，默认 revoke，再按最小需要授权。队列、凭证密文、worker 内部状态不向 `anon/authenticated` 开放。
- 所有跨表引用使用 `(id, user_id)` 复合外键或等价的事务内 owner 校验；禁止只凭 UUID 建跨账户关系。
- `claim_evidence` 与 AI claim 同事务写入，并用 deferred constraint trigger 或等价数据库约束保证 AI claim 至少一条有效 evidence。无有效证据的 AI 项不得成为 pending claim；run 可标为 `partial/failed`，并记录不含内容的校验计数。
- claims 的 origin、run 和 evidence 只允许 server-only 路径写入；`authenticated` 不能直接修改这些字段。confirm/edit/reject 通过绑定 `auth.uid()` 的专用 RPC 或已验证服务端动作完成，不能只靠隐藏 UI 按钮。
- 删除关系以 material revision 为边界级联 segments、runs、claims 和 evidence；未来 `resume_claims` 不允许静默保留一个看似仍有效的来源链接。
- 索引至少覆盖 owner + 状态/时间、revision segments、claim evidence、job lease/idempotency 和删除重试。

## 4. 状态与事实语义

### 4.1 素材处理

```text
stored → parse queued → parsing → ready for extraction
                           ├→ retry queued
                           ├→ unsupported / needs user input
                           └→ failed（素材仍保留）
```

解析不需要 provider 授权，但也不得因此暗中调用云端 OCR 或第三方解析 API。首个实现只使用已批准的内部 worker。

### 4.2 提取与审阅

```text
select scope → preview payload → user consent → extraction queued
→ running → validating → completed / partial / failed / outcome_unknown
```

- `completed` 可以表示“没有提取到事实”，不表示所有文本都已变成事实。
- `partial` 必须在 UI 显示有效/拒绝项数量及原因类别，不能把丢弃项静默伪装成成功。
- `outcome_unknown` 用于超时后无法确认 provider 是否已计费/生成的情况；无幂等保证时不得自动重放。
- claim 的 `pending/confirmed/rejected` 只由用户审阅操作改变。模型输出不包含也不能设置该字段。
- 用户编辑 AI claim 后仍为 `origin='ai'`，新增 revision 并重新确认；手动新增才是 `origin='user'`。手动内容也应在 UI 标明来源为 User added。
- 模型自报 confidence 不得展示成“事实正确概率”。CP3 不需要该数值参与确认或简历准入。

## 5. 提议的服务端接口变化

名称可在实现时遵循 Next.js 约定微调，语义不得缩减。

| 接口/动作 | 输入与返回 | 安全要求 |
|---|---|---|
| 保存/替换 BYOK credential | 一次 TLS 提交；只返回 provider、label、model、脱敏 endpoint、protocol、last_four、状态 | 认证、限速、请求体不记日志；响应无密文/明文；endpoint 通过 HTTPS/SSRF 校验 |
| 删除 BYOK credential | 返回删除状态 | 阻止新任务；不保证撤销 provider 侧 key，UI 明示 |
| 获取 extraction preview | revision、选中 segments、provider/model/protocol、目标域名与脱敏 endpoint、估算 tokens/费用、重试次数、payload hash | 只含当前用户选中的素材；不含 credential 内容；endpoint 需重新做 SSRF 校验 |
| 创建 extraction consent + run | revision/segment IDs、credential ID、payload hash、幂等键 | 重新计算 scope/hash，不能信任浏览器估算或 owner |
| 查询 run / retry | 状态、脱敏错误码、usage、claims 计数 | owner 检查；未知结果不可盲目自动重试 |
| confirm/edit/reject claim | expected version、动作、可选编辑文本 | 用户会话、owner、乐观锁；不接受模型直接调用 |
| 重试 parse/fetch | revision 与失败阶段 | 重新做文件/URL 安全检查；不复制旧授权到不同内容 |
| 删除 material/experience/account | deletion job 状态 | 延续 server-managed delete；可重复调用且结果一致 |

浏览器 DTO 可增加解析/提取状态、claims 和 evidence，但不得增加 ciphertext、wrapped DEK、worker secret、完整 provider 响应或原始错误堆栈。

## 6. 用户如何知道并控制外发数据

1. Provider 设置页说明：用户自己选择 provider、API key、model、endpoint 和 protocol；在 adapter 支持及安全校验通过后，CVMaster 按该配置调用。BYOK 的计费、数据政策、地区和撤销由用户选择的服务决定。
2. 每次提取前必须显示 provider、model、protocol、目标域名与脱敏 endpoint、素材名/revision、实际选中的 segments、文本预览、估算 token/费用和最大重试次数。无法估算费用时显示 unknown，不编造价格。默认不发送文件名、原始素材 URL、profile、账户其他素材或整段 experience。
3. 用户可取消选择片段、改用 note，或取消任务。CP3 不推荐“以后自动发送所有新素材”的全局授权。
4. 内容、provider、model、endpoint、protocol、adapter version、prompt/schema 或 scope 任一变化都会改变 payload hash，需要重新 preview + consent。重试完全相同的失败请求可引用原 consent，但仍受次数上限；不做未经同意的跨 provider fallback。
5. run 详情显示实际发送范围、目标域名、provider/model/endpoint/protocol/adapter version、时间、用途、usage 和状态；不展示或导出 BYOK，不记录完整请求或原始响应。
6. 自定义 endpoint 仅允许 HTTPS，并阻止内网、loopback、metadata、DNS rebinding 和危险 redirect；API key 只能发送到 preview 已展示且 consent 的目标。不支持的配置返回 `unsupported_provider` / `unsupported_protocol`，不静默切换服务。
7. 本地删除不能撤回已经发给 provider 的内容，也不能保证清除 provider 的滥用监测日志或备份；此限制必须在确认前可见，而非只藏在隐私政策里。

## 7. 删除与部分失败恢复

推荐采用可重放 saga，而非跨 Storage/Postgres 的假分布式事务：

1. 已认证服务端动作验证 owner，将目标标为 `deleting`，创建 `deletion_job`；阻止新 parse/extraction/consent。
2. 撤销未开始 queue messages，通知 worker 取消本地工作。已经发出的 provider 请求只能 bounded wait/记录，不能宣称撤回。
3. 删除原始私有对象、网页临时快照和派生临时对象；每一步把已完成阶段写入 deletion job。
4. 在一个 Postgres transaction 中删除 revisions、segments、runs、claims、evidence、consents 和 material 本体。experience/account 删除复用同一协调器并枚举全部目标。
5. 全部确认后才将 deletion job 标为 complete。任一步失败保留安全错误码和剩余对象清单，按指数退避重试；用户重试同一 deletion job，不新建重复级联。
6. Storage 已删而 DB 未删时，重试必须容忍对象不存在；DB 已删而辅助记录未删时，janitor 按 owner/target tombstone 完成清理。不得把半删状态恢复为 active。
7. 删除凭证只阻止未来使用；正在执行的请求可能完成。删除素材后，worker 提交结果时必须再次检查 revision 生命周期，已删除目标的结果丢弃且不落库。

CP4 契约：若历史 resume 引用了被删 claim，引用必须变成 `source_deleted` 并阻止其作为已验证事实进入新简历，或由用户明确选择删除受影响草稿。已导出的 `.tex/PDF` 和 provider 侧副本无法由本地删除收回，需要明确提示。

## 8. 选择的影响

| 选择 | 成本 | 隐私 | 部署 | 数据迁移 | 后续扩展 |
|---|---|---|---|---|---|
| 应用层信封加密 + 版本化 KEK | 无独立 KMS 调用费；有轮换运维 | 明文不落库；KEK 与密文分离 | 每个环境配置 KEK 与备份 runbook | credentials 新表；KEK rewrap 可在线分批 | 可升级 KMS，adapter 不变 |
| 独立受限 parse/fetch worker | 新增计算与运维成本 | 降低恶意文件/SSRF 波及主服务 | 需选托管、区域、egress 和临时盘策略 | jobs/revisions 为新增表 | 可加入 OCR/audio，但不自动扩大范围 |
| Provider-neutral adapters + 用户自选配置 | 按用户所选 model/endpoint、token 和重试计费 | 内容只发往 consent 的目标；保留政策随配置变化 | 自定义 HTTPS endpoint、协议适配与 egress 安全 | runs 保存 provider/model/endpoint/protocol/adapter/schema/prompt versions | 首个 OpenAI-compatible adapter 可验证 DeepSeek/Qwen 等，不限制品牌 |
| 多片段 evidence + revisions | 增加 DB 存储和写入 | 为证据保留必要文本，不默认保留原始 HTML/模型输出 | 无新增服务 | CP2 materials 采用增量 backfill/懒建 revision | 支持 JD 匹配、简历来源和重提取 |
| 每次发送前 consent | 无直接模型折扣，减少意外调用 | 用户控制最强 | 需要 preview/hash/run 接口 | 新增 consents | 未来可扩展为明确的分类型授权 |
| 严格大小/超时/重试上限 | 限制失控费用 | 减少临时内容与攻击面 | worker 必须能执行硬限制 | 无 | 不同 provider/文件类型可有独立 profile |

## 9. CP3 实现前置条件

以下全部通过后才可写 CP3 应用代码或 migration：

1. Steven/Codex 批准三份 ADR，并逐项关闭“待用户确认”清单；提案中的默认值不能被视为默认授权。
2. 确认用户选择的 provider 配置（provider/key/model/endpoint/protocol）、协议能力、对应数据保留说明、用户可见隐私文案、预算和每次 consent 粒度，以及是否接受 OCR/旧 DOC 不在首个纵向切片；不要求所有用户采用同一 provider。
3. 确认 worker 托管与区域、网络 egress 能拒绝非全局地址、硬 CPU/内存/临时盘限制、调度方式和预算。
4. 确认原始/派生内容保留、deletion tombstone、备份周期、queue archive 和日志保留；说明 provider 侧不可撤除副本。
5. 完成 migration 设计评审：复合外键、RLS/grants、索引、cascade/restrict、现有 materials backfill、前向修复和回滚边界。
6. 准备不含个人数据的 golden fixtures：中英文、混合日期/指标、多证据、重复 quote、缺证据、prompt injection、恶意 DOCX/PDF/HTML 和跨账户用例。
7. 用合成素材完成用户所选 provider 配置与 adapter 的评测：证据可定位率、无依据事实率、schema 通过率、人工确认率、延迟和单次成本；可优先验证 DeepSeek + Qwen，但不把验证对象变成产品硬限制，也不得只用“输出是 JSON”作为通过标准。
8. 配置开发/预览/生产分离的 KEK 与 worker secret；真实 BYOK 只由 Steven 在后续验收时通过受保护入口提供，绝不写入仓库或测试日志。
9. 明确 provider 请求幂等能力、超时后的计费/结果处理、速率限制和用户预算；无能力时必须实现 `outcome_unknown` 路径。

## 10. CP3 验收路径

建议按可独立审阅的小切片实施：schema/RLS → BYOK → queue/parser → consent/provider → claims review → deletion/regression。每片都不得先接真实个人素材。

### 安全与隔离

- 两个账户对 credentials metadata、jobs、revisions、segments、runs、claims、evidence 和文件做双向读写拒绝；匿名请求同样拒绝。
- 构建产物、浏览器存储、网络响应、应用/worker 日志和错误中均无明文 BYOK、service role、KEK 或完整个人素材。
- 篡改 nonce/ciphertext/AAD 必须解密失败；KEK 轮换、provider key 替换/删除及进行中的任务行为符合 ADR-001。

### 解析与队列

- SSRF 用例覆盖 IPv4/IPv6 私网、loopback、link-local、metadata、DNS rebinding、每次 redirect、非默认端口、压缩和超限响应；全部被阻断且只记录安全错误码。
- 恶意/畸形文件、zip bomb、外部 DOCX relationship、PDF active content、超时和内存限制均不会影响主 Web 服务或其他账户。
- 同一 job 重复投递、worker 在写库前后崩溃、lease 过期和重复点击重试均不产生重复 claims 或失控 provider 调用。

### 证据与用户控制

- preview 中可见的范围、provider/model/protocol 和目标域名与实际请求逐字段一致；未选素材、profile、URL 凭证和其他账户数据不出现。更换 provider/model/endpoint/protocol/adapter version 必须重新 consent。
- 自定义 provider endpoint 的 HTTPS、私网/loopback/metadata、DNS rebinding、危险 redirect 和密钥目标绑定测试全部通过；key 不会发送到未展示目标，日志无 key、完整请求或原始响应。
- 不支持的配置明确返回 `unsupported_provider` / `unsupported_protocol`，不发生静默 fallback；伪造 quote、错误 offsets、跨 revision segment、空 evidence、额外字段和截断 JSON 均被服务端拒绝，有效 AI claims 只能为 pending。
- confirm/edit/reject 都有独立审计；模型重跑不会把 rejected/edited claim 静默恢复为 confirmed。
- 无证据项、部分失败和缺失提示不会进入“已确认事实”集合。

### 删除与恢复

- 分别注入 Storage 删除失败、DB transaction 失败、queue 取消失败和 worker 提交竞态；重试后原文件、派生文本、runs、claims、evidence 和来源引用全部清理，且无跨账户残留。
- 重跑已完成删除必须得到相同完成结果；不恢复为 active，不重复报错泄露对象信息。
- CP2 注册、建星、note/link/file、私有下载、双账户隔离和现有 server-managed delete 回归全部通过。

最后才可进行 Steven 的小规模真实验收：使用自己的测试 provider key 和可发送素材，核对实际账单/usage、确认/编辑/拒绝、来源跳转、失败重试和删除提示。build/lint/typecheck 是必要项，但不能替代以上运行与安全证据。
