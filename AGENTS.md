# CVMaster 仓库级协作入口

开始任何实现前，必须阅读 [docs/AGENTS.md](docs/AGENTS.md) 与对应 checkpoint 文档。所有前端工作额外遵循 [docs/UI.md](docs/UI.md)。

Workbuddy 完成一组改动后，创建 Git commit，并直接把短 commit SHA（例如 `07ccef`）发给用户；用户会将 SHA 转交给 Codex 审阅。提交不得包含密钥或本地环境文件。

Codex 审阅明确通过后，直接将已审阅的 commit push 到 GitHub；push 成功后，给用户下一轮开工 prompt。
