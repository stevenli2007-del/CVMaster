# CVMaster 数据模型

状态：v0.1 概念模型。实现时拆成带 RLS 的 SQL migrations，并验证跨用户读写拒绝。

## 1. 关系图

```text
auth.users
  └─ profiles (1:1)
      ├─ experiences (1:N)
      │   ├─ materials (1:N)
      │   │   └─ extraction_runs (1:N)
      │   │       └─ claims (1:N; source_material_id required)
      │   └─ claims (1:N; optional experience-level relation)
      ├─ ai_credentials (1:N; encrypted payload only)
      └─ job_applications (1:N)
          ├─ job_requirements (1:N)
          └─ resume_versions (1:N)
              └─ resume_claims (N:M claims, with per-version text/order)
```

`user_id` 是所有权边界。所有公开 schema 业务表都启用 RLS；Storage 对象路径采用 owner UUID 前缀并另设 Storage policies。

## 2. 核心实体

### profiles

- `id uuid primary key references auth.users(id) on delete cascade`
- `display_name text`, `email/contact fields jsonb`, `locale text`, `created_at`, `updated_at`
- 可选简历偏好以受控 JSON schema 保存，不接受任意脚本/模板代码。

### experiences

- `id uuid`, `user_id uuid`, `name text`, `kind text null`, `summary text null`
- `status text`（active/archived）, `created_at`, `updated_at`
- `kind` 可由 AI 建议；用户无需创建时填写。

### materials

- `id uuid`, `user_id uuid`, `experience_id uuid`, `type text`（web/github/note/voice/image/file）
- `source_url text null`, `object_key text null`, `text_content text null`, `original_filename text null`
- `mime_type text null`, `size_bytes bigint null`, `content_hash text null`
- `processing_status text`（queued/processing/ready/failed）, `error_code text null`
- `created_at`, `updated_at`; 不在通用 error 字段存原文或凭证。

### extraction_runs

- `id uuid`, `user_id uuid`, `material_id uuid`, `provider text`, `model text`
- `endpoint text`（规范化且不含 secret）, `protocol text`, `adapter_id text`, `adapter_version text`
- `prompt_version text`, `schema_version text`, `status text`, `started_at`, `finished_at`
- `usage jsonb null`（token 与成本计量，不含 prompt 原文）；原始模型输出默认不保存。

### claims

- `id uuid`, `user_id uuid`, `experience_id uuid`, `source_material_id uuid null`
- `category text`（role/action/technology/outcome/metric/date/learning/other）
- `claim_text text`, `evidence_quote text null`, `evidence_locator jsonb null`
- `state text`（proposed/confirmed/rejected/manual）, `confidence numeric null`
- `created_by text`（ai/user）, `confirmed_at timestamptz null`, `created_at`, `updated_at`
- `source_material_id` 为空时只允许 `state='manual'`，并记录用户手动输入来源。

### ai_credentials

- `id uuid`, `user_id uuid`, `provider text`, `label text null`, `model text`, `endpoint text`, `protocol text`
- `ciphertext text`, `key_version text`, `last_four text null`, `created_at`, `updated_at`
- 禁止保存明文 key；endpoint 必须规范化且不含 secret。客户端只读 provider、label、model、endpoint、protocol、last_four 等非敏感配置；写入、解密和删除仅走授权服务端路径。实际加密方式需 ADR-001。

### job_applications / job_requirements

- `job_applications`: `id`, `user_id`, `title`, `company text null`, `description text`, `source_material_id uuid null`, `created_at`, `updated_at`
- `job_requirements`: `id`, `user_id`, `job_application_id`, `requirement_text`, `category`, `priority`, `created_at`

### resume_versions / resume_claims

- `resume_versions`: `id`, `user_id`, `job_application_id`, `version_number`, `template_id`, `template_version`, `modules jsonb`, `tex_source text`, `pdf_object_key text null`, `status`, `created_at`
- `resume_claims`: `id`, `user_id`, `resume_version_id`, `claim_id uuid null`, `rendered_text`, `section`, `sort_order`, `source_state text`, `created_at`
- `claim_id` 可以为空以允许用户在当前简历中手动补充；手动内容仍须与模型生成事实区分。

## 3. 所有权与访问策略

- 每个业务表包含 `user_id`，并建立外键确保关联实体属于同一用户；在实现中用复合外键或事务内校验阻止跨 owner 关联。
- RLS：用户只能 select/insert/update/delete 自己的行；插入/更新时校验 `user_id = auth.uid()`。
- AI/抓取/导出接口从已验证会话取得 owner ID，不能信任请求体里的 `user_id`。
- `service_role` 会绕过 RLS，只在服务端使用；每次访问仍需显式过滤已验证 owner ID。
- 私有文件下载使用 owner 检查后签发短时 URL；不开放公开 bucket。
- `ai_credentials` 的表策略不授权客户端访问密文；凭证操作走限定的服务端函数，并防止批量列出/解密。

### CP3 已落地表（migration 实际 schema）

> 概念模型小节（上方）仍为 CP0 基线，尚未整体同步；CP3 migration `20261125160000_cp3_extraction_schema_rls.sql` 实际创建的表如下，字段以迁移为准。

- `ai_credentials`：owner/provider/label/model/endpoint/protocol/last_four + `ciphertext/nonce/wrapped_dek/wrapped_dek_nonce/kek_version/status`。客户端仅列级读取非敏感配置与 metadata，密文列永不授权给 anon/authenticated。
- `material_revisions`：`material_id/user_id/revision_no`、`content_hash/parser_version/parse_status/error_code`，不可变来源快照。
- `material_segments`：`revision_id/user_id/sequence`、`text_content/content_hash/source_locator`，规范化分块与证据锚点。
- `processing_jobs`：job 类型/状态/幂等键/attempt/lease/安全错误码；对 anon/authenticated 完全关闭。
- `extraction_consents`：`material_revision_id/credential_id`、provider/model/endpoint/protocol/adapter/prompt/schema 版本、`payload_hash`，证明用户同意发往哪个目标。
- `extraction_consent_segments`：consent 的 segment scope 关联表（`consent_id/segment_id/revision_id/user_id`）；复合外键贯穿 `revision_id` 保证所选 segment 确属 consent 的 revision。
- `extraction_runs`：`consent_id/credential_id`、版本/usage/attempts/状态/安全错误码；原始模型输出不落库。
- `claims`：`origin(ai/user)` 与 `review_state(pending/confirmed/rejected)` 分离；`run_id/experience_id`；AI claim 必须绑定 run 且至少一条 evidence。
- `claim_revisions`：用户编辑审计，不覆盖 AI 原始提案。
- `claim_evidence`：claim/segment/run 多对多证据，服务端校验 quote/offsets。
- `deletion_jobs`：可重放删除 saga 状态；对 anon/authenticated 完全关闭。

## 4. 索引与生命周期

- 主要索引：每表 `(user_id, created_at desc)`；`materials(experience_id, created_at)`、`claims(experience_id, state)`、`job_requirements(job_application_id)`、`resume_versions(job_application_id, version_number desc)`。
- URL/文本/文件原始内容的保留周期由隐私决策确定；用户删除素材时删除对象、处理文本、claims 来源链及引用它的简历内容或标记其来源已删除。
- 删除账户按级联流程删除业务记录、凭证和私有文件；Storage 清理要有可重试任务并记录完成状态。
- 模型/提示词版本作为审计元数据保存；不要为调试而保留不必要的完整个人数据快照。
