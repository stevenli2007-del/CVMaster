# ADR-001：BYOK 密钥的存储、加密、访问、轮换和删除

状态：Proposed（待 Steven 与 Codex 审阅）
日期：2026-11-25
关联：[CP3 总体设计](../design/CP3-ai-extraction-evidence-design.md)、[ADR-004](ADR-004-ai-provider-output-schema.md)

## 背景

CVMaster 让用户使用自己的 provider API key。`docs/DATABASE.md` 只有概念上的 `ai_credentials(ciphertext, key_version, last_four)`，CP2 尚未创建该表。密钥一旦泄露，会造成用户账户和费用损失；只隐藏 UI 或对密文做 base64 不构成保护。

本 ADR 决定推荐的密码学边界与生命周期，不选择或保存任何真实 key。

## 推荐方案

采用**应用层信封加密（envelope encryption）+ 每凭证随机 DEK + 部署平台中的版本化 KEK**。

### 1. 数据与算法

每条 credential 创建时：

1. 服务端生成随机 256-bit DEK，用 AES-256-GCM 加密用户 key；每次使用独立随机 96-bit nonce。
2. 使用当前 KEK 和另一独立 nonce 包裹 DEK。数据库只保存：
   - `id/user_id/provider/label/last_four`；
   - `ciphertext/nonce/auth_tag`（tag 可与 ciphertext 按统一格式编码）；
   - `wrapped_dek/wrapped_dek_nonce/wrapped_dek_tag`；
   - `kek_version`、状态、created/updated/rotated timestamps。
3. AAD 绑定协议版本、`user_id`、`credential_id`、`provider`，防止把密文复制到其他用户或 provider 后解密。
4. KEK 为至少 256-bit 的随机密钥，存放在 Vercel/secret manager 的服务端环境变量或 secret 中；`BYOK_ACTIVE_KEK_VERSION` 指定当前版本。KEK 不与密文放在同一数据库，不使用 `NEXT_PUBLIC_` 前缀。
5. 使用运行环境审计过的标准 crypto 实现，不自创算法、不复用 nonce、不用固定 IV、不用密码直接当 KEK。

`last_four` 只用于用户辨认，不参与加解密。默认不保存可暴力比对的 key hash/fingerprint。

### 2. 浏览器与服务端边界

BYOK 有一个不可回避的明文入口：用户必须在浏览器表单录入 key。**“不写入浏览器”应理解为不持久化、不回显、不回传，而不是声称浏览器从未处理输入。**

- 使用 password 类型输入、同源 HTTPS、禁止自动填充到持久表单；不放入 URL/query、cookie、localStorage、sessionStorage、IndexedDB、全局调试对象或分析事件。
- 提交后立即清空输入和客户端状态；服务端从不在 GET、页面 props、DTO、错误消息或后续响应中返回明文。
- credential 路由禁用请求体日志，provider 错误先映射为安全错误码。反向代理只能记录路径，不能记录提交内容。
- 明文 KEK、DEK、provider key 仅存在于服务端短生命周期变量中，只在授权 AI 调用前解密；不进入 queue、job payload、extraction run、日志或临时文件。
- JavaScript 无法保证可靠的物理内存清零；只能缩小作用域、尽快释放引用，不宣称“已安全擦除 RAM”。

### 3. 访问控制

- `anon/authenticated` 对密文字段和内部密钥操作零权限；浏览器只能读取 provider、label、last_four、状态和时间等非敏感 metadata。
- 保存、替换、删除、解密分别走独立服务端函数。解密函数不暴露为通用 Route Handler，也不接受任意 credential ID 列表。
- AI worker 从已验证、owner 匹配、状态 active 的 run 取得单个 credential ID，在发请求前解密一次。禁止批量列出或导出明文。
- provider base URL 使用服务端 allowlist 和 HTTPS，禁止用户提供的 arbitrary base URL/redirect 把 Authorization 转发到攻击者域名。
- service role 只在服务端使用且仍需显式 owner 条件。拥有数据库和 KEK 的运维主体仍能解密，这是剩余信任边界，需通过环境隔离、最小权限和审计降低风险。
- “Test connection” 若后续加入，必须由用户单独触发、只访问 provider 官方端点且不携带素材；保存 key 不隐式发送素材。

### 4. 两类轮换

**用户替换 provider key：**

- 在同一 DB transaction 中生成新 DEK/nonce、加密并替换密文和 last_four；旧值不写入历史表。
- 新 run 只使用新密文。已经解密并发出的请求可能完成，正在排队但尚未读取凭证的任务应重新读取并获得新 key。
- 替换不撤销旧 provider key；UI 提供到 provider 官方控制台的路径，提醒用户按需撤销旧 key。

**CVMaster KEK 轮换：**

1. 部署新 KEK 版本但暂时保留旧版本可读，active 指向新版本。
2. 分批读取旧 `wrapped_dek`，用旧 KEK 解包、用新 KEK 重新包裹；无需解密用户 provider key。
3. 每批使用版本条件更新，记录行数/失败码而不记录密文或 DEK；重复执行不产生变化。
4. 全部当前行验证完成后才移除旧 KEK。备份中的旧密文与旧 KEK 保留/销毁时序必须纳入恢复 runbook，不能只删旧 KEK 后宣称备份已清理。

### 5. 删除与失效

- 删除时先标记 `deleting` 以阻止新 run，再删除 credential 行；不保存明文“回收站”。同一删除操作幂等；若在标记后中断，用户重试或维护任务完成硬删，不能恢复为 active。
- 已发出的 HTTP 请求无法可靠撤回；bounded wait 后结束本地任务。重试不再保留 key，后续任务以 `credential_unavailable` 安全失败。
- 本地删除不等于 provider 撤销。UI 必须明确提示用户到 provider 控制台撤销，尤其在疑似泄露时。
- DB 备份可能仍含 ciphertext，但不含 KEK；备份保留期限和旧 KEK 销毁时间待隐私决策。
- 账户删除复用统一 deletion workflow，枚举 credentials、runs 和私有文件；部分失败可重试，不把凭证行恢复为 active。
- 若 KEK 疑似泄露，立即禁用解密入口、轮换 KEK、重新包裹所有 DEK 并审查访问；若 provider key 可能已暴露，仅轮换 KEK 不足，用户仍需撤销 provider 侧 key。

## 备选方案与取舍

| 方案 | 优点 | 代价/风险 | 结论 |
|---|---|---|---|
| A. 应用层信封加密 + 部署 secret KEK（推荐） | 无新运行时依赖；可移植；支持独立 rewrap；清晰适配 Vercel/Supabase 分离 | 应用运维承担算法参数、nonce、轮换和备份职责；应用环境仍是信任边界 | 适合 CP3，但必须先做单测与安全审阅 |
| B. Supabase Vault | 托管加密能力，减少自行管理密文格式 | decrypted view/RPC/grants 配置错误会扩大暴露；service role 信任面大；备份/轮换和可移植性需单独验证 | 可作替代，不与 A 混用；选择前需真实开发项目验证 |
| C. 云 KMS 信封加密 | KEK 不直接进应用环境，支持更细权限和审计 | 新云服务、区域/费用/IAM/延迟和离线开发复杂度 | 规模化或合规要求提高时优先升级 |
| D. 只存浏览器/每次手动输入 | CVMaster 不持久化 key | 浏览器持久化反而更易被 XSS/扩展读取；每次输入体验差 | 不推荐持久化到浏览器；可提供“不保存 key”产品选项但另作决策 |
| E. 平台代付、不采用 BYOK | 用户无需管理 key | 成本与滥用由平台承担，不符合当前 BYOK 基线 | 非 CP3 方案 |

## 风险与缓解

- **XSS 读取首次输入**：最小化客户端依赖与脚本、CSP、输入用后清空；不在客户端持久化。剩余风险无法由加密消除。
- **日志/异常泄露**：允许字段日志、脱敏错误映射、无 body 日志；自动扫描测试包含诱饵 key，任何出现即失败。
- **密文复制到其他账户**：AAD + owner 外键 + 单条授权读取。
- **运行中轮换/删除竞态**：credential 状态、run attempt 和结果提交检查；明确“已发出不可撤回”。
- **KEK 与 DB 同时泄露**：属于灾难场景；环境分权、secret 审计、轮换 runbook，未来 KMS 降低但不能完全消除应用解密权限风险。
- **备份残留**：只含密文不等于完成隐私删除；需在用户说明中披露备份周期和 KEK 销毁策略。

## 待用户确认

1. 是否接受推荐 A，以及首版使用部署平台 secret 而非独立 KMS？
2. 是否接受“浏览器仅首次输入时 transient 处理，绝不持久化/回传”的准确边界？若要求浏览器完全不接触明文，只能改选 provider OAuth 等方案。
3. 是否提供“只使用一次、不保存 key”的额外模式？这会增加每次提取输入成本，不属于默认推荐。
4. KEK 轮换频率、旧 KEK 销毁时点、数据库备份保留周期及加密备份恢复演练负责人。
5. 删除/替换 key 时，对进行中任务的 UX：推荐“阻止新任务，允许已发出请求 bounded wait 后结束”，是否接受？
6. 是否需要在 UI 提供 provider 官方撤销链接和疑似泄露 runbook？推荐需要。

## 实施验收证据

- 已知测试向量、随机 nonce、AAD 篡改、密文/DEK 篡改、错误 KEK 版本均通过测试；两次加密同一输入不产生相同密文。
- 连续执行两次 KEK rewrap，第二轮 `updated=0`；轮换前后均可正常使用，旧版本撤除后旧备份行为符合已批准 runbook。
- 两账户无法互读 metadata 或触发对方 credential 解密；无批量解密 API。
- 静态构建产物、浏览器存储、响应、日志和异常中不含测试明文 key；credential 请求体不进入日志，access log 仅保留安全路径、状态码和脱敏 metadata，不含 query/body。
- 替换/删除与 queued/running/completed run 的竞态均有测试；本地删除未被描述为 provider 撤销。
