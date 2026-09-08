# M0 工程底座实施计划

目标：按 R5 建设独立工程，真实验证空库启动、项目重启恢复和重复队列投递。
依据：AGENTS.md、PRD 01/03/04/05、R1/R2、R5。用户已授权执行 M0；采用 R5 建议基线作为本轮工程选择。仓库尚无首个提交，原有全部文件未跟踪，直接在新目录实现，不代替用户提交原始资料。

## 设计与边界
React/TypeScript/Vite → FastAPI → PostgreSQL；API 事务写 Job + Outbox，dispatcher 派发 Celery/Redis，独立 Worker 用租约 token 防止旧执行者回写。数据库保存任务状态、尝试及事件。M0 只开放无外部付费副作用的文件 SHA256 验证任务；后续供应商任务须扩展对账流程，不能盲目重试。
文件用本地 StorageAdapter 和相对 objectKey，元数据在 PostgreSQL。项目创建没有画幅和时长；本地固定 owner，所有资源按 owner/project 查询；源变更用 revision 冲突保护。配置层使用环境变量，不读取已有密钥文件。OpenAPI 导出并生成 TS 类型，前端使用类型化客户端。
提供 Compose 及本机运行方式；本机隔离 PostgreSQL 端口 55432、Redis 56379、API 8010、Web 5180，不接管已有数据库。

## 执行与验证
- [x] 1. 固定依赖与运行时，建立目录、迁移和种子；空库升级、重复升级、降级再升级验证。
- [x] 2. 先写项目/文件/配置 API 行为测试，验证缺失实现失败；实现事务保存、版本冲突、上传校验、路径隔离。
- [x] 3. 先写幂等/重复执行/租约恢复测试，验证失败；实现 Job + Outbox + Worker + 恢复扫描；用真实 Redis 与子进程杀死 Worker 演练。
- [x] 4. 建立项目列表/创建/继续编辑、文件上传与任务记录界面；导出 OpenAPI 生成客户端；构建与浏览器检查。
- [x] 5. 提供 bootstrap/dev/test/backup/restore-check；重启数据库与 API 后核对内容；备份恢复到隔离数据库与新媒体目录；记录实测结果与限制，同步 AGENTS/R5。

不在 M0 接入 AI、故事/分镜编辑器、真实视频生成或 MP4 成片。创作等入口标识后续阶段，不展示伪造生成结果。
