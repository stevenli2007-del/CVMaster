# CVMaster 技术栈与架构基线

状态：v0.1 建议基线；进入实现时锁定具体版本并补充 ADR。

## 1. 选型

- Web：Next.js App Router + TypeScript，部署至 Vercel。新项目使用开工时最新的受支持稳定主版本。
- UI：React + CSS Modules / CSS variables，不使用 Tailwind；使用 Three.js WebGL 实现交互式 3D 粒子星图，可用 `@react-three/fiber` 做 React 渲染绑定；DOM 承载表单、面板和可访问控件。
- 包管理器：npm，提交 `package-lock.json` 保证依赖安装可复现。
- CP1 星球少，使用固定种子坐标布局，避免引入模拟依赖；真实数据规模和关系更明确后，再评估 `d3-force-3d`。
- 数据与账户：Supabase Auth + PostgreSQL，使用 Supabase Storage 保存私有文件。
- 服务端：Next.js Route Handlers / Server Actions 负责授权后的业务操作和 AI 调用；耗时处理可迁移到队列/后台 worker。
- AI：Provider adapter 层统一 BYOK 请求、结构化输出、重试、限流与错误；首版 provider 清单在实现前确认。
- 校验：Zod（或同类 schema validator）校验用户请求、数据库边界和模型输出。
- 观测：脱敏错误追踪与指标；禁止收集原始简历、素材和凭证。

## 2. 系统边界

```text
Browser
  ├─ 登录态 Supabase client：只访问受 RLS 保护的用户数据
  ├─ 上传私有对象：使用短时授权 URL 或受限上传策略
  └─ 调用同源业务接口（不持有 BYOK key / service role key）
       ↓
Vercel server functions
  ├─ 校验身份、对象所有权、配额与输入大小
  ├─ 读取/解密用户 BYOK 凭证（仅在服务端）
  ├─ 执行 URL 安全抓取、AI 提取、JD 匹配、LaTeX 渲染
  └─ 返回经过 schema 验证的最少必要结果
       ↓
Supabase Auth + Postgres (RLS) + private Storage
       ↓
外部模型 Provider（仅接收本次任务所需内容）
```

## 3. 安全基线

- `anon`/publishable key 可以进入浏览器，但数据库访问必须依赖正确 grants 与 RLS；service role key 只允许服务端使用。RLS 要覆盖每张暴露用户表。
- 每个业务接口先验证登录用户，再校验被访问对象属于当前用户；不能依赖前端隐藏按钮。
- BYOK API key 不回传明文、不写日志、不进入浏览器持久化。加密存储由服务端完成，解密权限限定到 AI 请求路径；未完成密钥管理 ADR 前不得上线持久化密钥功能。
- 对模型 provider 明示数据会发送到用户选定的 provider；配置 provider 不等于允许把账户中所有材料无差别发送出去，每次任务只发送所需内容。
- URL 导入防 SSRF：只允许 http/https；拒绝 loopback、私网、link-local、metadata 地址；解析并校验 DNS 和每次重定向目标；限制跳转、响应大小、MIME、超时；禁止携带用户 cookie；内容提取在隔离/受限环境执行。
- 文件上传校验 MIME 与大小，使用随机对象 key、private bucket、短时下载 URL；不把用户文件名当路径。
- AI 和 LaTeX 内容均视为不可信输入；HTML 渲染转义，命令/文件路径不得由模型直接控制，LaTeX 特殊字符必须编码。
- 设定请求限速、文件配额、AI 花费上限和并发限制；服务端对 provider 错误做脱敏。

## 4. AI 流程

### 素材提取

1. 输入归一化为带来源 ID 的文本/元数据；文件解析过程保留原始对象引用。
2. 使用版本化 prompt 与 schema 提取 claims、原文证据片段、时间/角色/技术/成果、待补字段。
3. 校验输出并保存结构化结果与模型/提示词版本；来源证据必须定位到素材或内容片段。
4. 用户确认前标记 `proposed`；用户确认/修改后成为可用于简历的 `confirmed` claim。

### 简历生成

1. 解析 JD 成要求项。
2. 候选召回只从当前账户素材中选取；优先 confirmed claims。
3. 用户审阅相关性、证据来源和模块选择。
4. 生成结构化简历数据；每个 claim 需要来源引用或用户手动输入标记。
5. 使用版本化 LaTeX 模板渲染；输出可编辑的 `.tex`，PDF 编译由独立、受限的编译路径处理。

## 5. 文件与部署

- Supabase Storage bucket 必须 private；数据库只保存对象 key、MIME、大小、校验和及关联 owner。
- 迁移在 `supabase/migrations/`；开发/预览/生产使用隔离的 Supabase 项目和 Vercel 环境变量。
- 所有环境变量通过部署平台管理； `.env*` 私密文件不提交，提供 `.env.example` 仅列变量名。
- 上传解析、抓取、AI 和导出具有状态、超时、重试策略；超过 Vercel 同步请求适配范围时改用后台任务，不阻塞页面。

## 6. 性能与可访问性

- MVP 先针对电脑端调优星图 WebGL 的 DPR、粒子数与后处理；WebGL 不可用时用静态/低成本 Canvas 视觉降级；减少动态效果时暂停或禁用非必要动画。移动端性能配置留到后续版本。
- 主要工作流有 DOM 语义界面；Canvas 不承载唯一可操作入口。
- 大文件解析、PDF 编译、模型流式内容均有进度与失败恢复。
- 对模型调用设置 token、超时、并发和重试上限；避免重复提交造成重复成本。

## 7. ADR 必须项

1. ADR-001：BYOK 密钥加密、访问、轮换和删除。
2. ADR-002：LaTeX 编译隔离、资源限制和 PDF 导出。
3. ADR-003：文件/网页解析队列与数据保留策略。
4. ADR-004：首发 AI provider 与模型输出 schema。

## 8. 官方参考

- [Next.js Support Policy](https://nextjs.org/support-policy)：新项目优先使用 Active LTS；Next 15 目前为 Maintenance LTS。
- [React Three Fiber repository](https://github.com/pmndrs/react-three-fiber)：R3F 9 与 React 19 配对。
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)：公开 schema 的授权需要同时审阅 grants 与 RLS policies。
- [Supabase Vault](https://supabase.com/docs/guides/database/vault)：可存放加密 secrets；解密视图和 SQL 权限必须严格限制。是否用于用户 BYOK 仍需 ADR-001 决定。
- [Vercel Functions](https://vercel.com/docs/functions)：为服务端 API 和外部服务调用提供函数运行环境。
- [Starbase](https://github.com/verycracked/starbase)：交互式 3D 代码星云、力导向布局、节点聚焦与邻接连线参考。
- [Atomic Globe](https://www.framer.com/marketplace/components/atomic-globe/)：WebGL 粒子聚合、拖拽旋转、光标反馈与性能适配参考。
