# M0 工程底座验收 · 2026-09-08

结论：M0 的本地原生进程退出条件已通过实际验证。Docker Compose 交付配置与固定镜像摘要，当前机器没有 Docker，容器构建/启动未计入通过事实。M1–M4 和 A01–A07 成片验收尚未完成。

## 已读背景与工程选择

已阅读根目录 AGENTS、PRD 01/03/04/05、R1/R2、R5 及 manifest；R4 JSON 用于28项契约指令种子。产品是 AI短片工坊，五模块/五创作阶段；先一句话主链，再共用 TXT。新项目画幅为空，不预设时长；AI 建议由用户采用，版本和历史保留；完整 MP4 才是产品目标。

现有 Demo 的页面、标注、跳转由 `interaction-prd.json` 索引，静态页面位于 `prototypes/pages`、共享样式/模拟交互位于 `prototypes/shared`，阅读器在 `runtime`。本轮只同步 AGENTS 与 R5 工程进度，没有重写 Demo/阅读器。

采用 R5 建议技术基线实施 M0，不将尚未验证的供应商/FFmpeg/上线配置写成已完成。仓库初始没有首个提交、所有原始 PRD 文件均未跟踪；本轮保留工作区改动，不代用户提交原始文件或创建无关 PR。

## 退出条件与证据

| 退出条件 | 实际验证 | 结果 |
|---|---|---|
| 空环境可启动 | 新建项目专用 PostgreSQL 集群与数据库；Alembic 空库升级；make bootstrap 依赖锁安装/迁移/种子；make dev 独立应用进程 | 通过 |
| 保存项目后重启可继续 | 浏览器新建并改名，停止应用、实际重启 PostgreSQL，以全新 API 进程读取原项目名称/revision/文件/成功任务 | 通过 |
| 队列重复投递不重复落库 | 4 个并发 HTTP 同键提交只产生同一 Job；4 个并发执行及真实 Redis 4 次重复消息，只存在1条 job_results | 通过 |
| Worker 中断可恢复 | 用 FIFO 在真实 Worker 提交 running 后阻塞文件读取，SIGKILL；恢复扫描令过期租约回 queued；新 Worker 完成；1条结果、2条尝试 | 通过 |
| 媒体及数据可迁移 | pg_dump custom + 全文件 SHA256；恢复到独立数据库及另一媒体目录；7个项目、5个媒体文件哈希及 API 校验 | 通过 |

完整运行链路还通过 HTTP 图片上传 → Job/Outbox 事务 → 独立 dispatcher → Redis → Celery Worker → PostgreSQL 成功状态，浏览器“任务记录”已显示完成。校验任务不修改项目完成状态，不代表生成了 AI 素材。

## 自动检查与人工检查

`make test`：9项测试通过，包含真实 PostgreSQL/Redis/Worker；测试脚本自动创建和销毁隔离库/媒体目录，迁移 upgrade → 重复 upgrade → downgrade base → upgrade head。`make test` 同时验证 OpenAPI 快照与运行代码一致，并完成 TypeScript 编译及 Vite 构建。

`make check`：Ruff 通过。PRD `npm run validate`：23个模块、11页、68条关系。前端生产构建成功。浏览器验证项目创建、保存、继续、真实任务状态及页面排版。

实测运行时为 Python 3.12.14、Node 26.7.0、PostgreSQL 18.6、Redis 7.4.2。测试有2条 Starlette/httpx 上游弃用警告，未被隐藏，未影响通过。镜像摘要由 Docker 官方 Registry 查询并固定在 `infra/images.json`；Compose 运行仍需装有 Docker 的环境验证。

## 当前交付边界

项目 API 支持创建、分页、读取、改名和 revision；PNG/JPEG/WebP 文件真实验收、落盘、SHA256、按 owner/project 隔离；配置为服务端环境参数、本地身份、项目类型、未经模型验证的契约指令种子和只读概览。五模块应用壳有三主题，创作内容、完整配置编辑、项目风格模板与其他生产功能按后续里程碑实施。

任务当前只开放无外部副作用的 file.verify。Job/Outbox 持久化、幂等键冲突、lease token、心跳、尝试与事件、Redis 丢消息扫描已实现；付费任务的 provider_task_id、unknown 对账、取消、依赖图与 SSE 尚未实现，不能直接复用本地任务的自动重试规则处理付费生成。

本地默认身份与数据库 trust 仅适用回环地址/本机开发容器网络；公开部署前必须按 R5 完成身份和访问校验。FFmpeg 编码器、真实 AI 和 MP4 未接入。

## 技术依据

实现采用数据库事务保存任务状态，消息仅携带 ID；Celery 不保证业务执行恰好一次，重复投递由数据库锁、状态与结果主键处理。[Celery 官方任务与幂等文档](https://docs.celeryq.dev/en/stable/userguide/tasks.html)、[SQLAlchemy Session 事务说明](https://docs.sqlalchemy.org/en/20/orm/session_basics.html)。

交付清理：恢复演练完成后，清理已核对 ID 的6条本任务临时项目及对应测试文件，保留“ M0 验收 · 已保存并可继续 ”项目及1份校验图片；清理前完整备份保留。服务重新启动后，浏览器刷新确认项目总数为1，名称及更新时间保持。Compose YAML 静态解析通过（8个服务，包含迁移服务）；静态解析不替代容器启动。
