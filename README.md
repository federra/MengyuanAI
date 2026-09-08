# AI短片工坊

从零建设的 PC Web 短片创作系统。M0 提供工程底座，M1 故事工程已接入 DeepSeek 适配器与版本工作台；真实文本调用验收等待密钥注入。剧本/分镜、参考图/TTS/视频与 MP4 继续按 M1–M3 实施。需求与交互 Demo 保存在独立的 `interaction-prd-workspace/`，不参与应用构建。

## 工程结构

```text
apps/web/                  React + TypeScript + Vite 五模块应用壳
  src/generated/api.d.ts   从 OpenAPI 生成的类型，配合 openapi-fetch 客户端
services/backend/
  src/shortfilm/
    projects/              项目保存、owner 隔离、revision 冲突
    creation/              故事版本、导演建议、DeepSeek 适配器与恢复
    assets/                M2 资产版本领域边界
    media/                 StorageAdapter、图片验收与受控读取
    jobs/                  事务入队、dispatcher、Celery、租约恢复
    settings/              本地运行配置与种子概览
    data/                  R4 契约指令种子（未经真实模型验证）
  migrations/              Alembic 版本脚本
  pyproject.toml / uv.lock Python 依赖及完整锁文件
contracts/openapi.json     后端契约源的导出快照
infra/                     Compose、镜像摘要、Dockerfile、Nginx
scripts/                   启动、隔离测试、备份与恢复演练
tests/                    PostgreSQL 行为测试、真实 Worker 故障恢复测试
docs/engineering/         M0 实施计划及验收记录
.local/                    忽略入库：数据库、Redis、媒体、日志、备份
```

## 本机启动

前置：Python 3.12（uv 自动管理）、uv、Node ≥22.12、PostgreSQL 18、Redis 7.4。本次实测 Python 3.12.14 / Node 26.7.0 / PostgreSQL 18.6 / Redis 7.4.2；Python 与前端依赖分别锁在 uv.lock、package-lock.json。项目内 `.local/bin/redis-server` 为本机编译产物，不随仓库分发。

```sh
make bootstrap
make dev
```

应用：[http://127.0.0.1:5180](http://127.0.0.1:5180)；API：[http://127.0.0.1:8010/docs](http://127.0.0.1:8010/docs)。数据库 55432、Redis 56379，均仅本机。`make dev` 同时启动 API、AI/媒体 Worker、dispatcher、Vite；Ctrl+C 停止这些应用进程，数据库与 Redis 保留运行，下一次 bootstrap 不清数据。日志在 `.local/`。若端口被其他服务占用，命令停止并提示，不接管其他项目。

本地固定身份和无口令数据库仅服务本机开发，不能直接公网部署。应用只从环境变量读取 `SHORTFILM_DATABASE_URL`、`SHORTFILM_REDIS_URL`、`SHORTFILM_STORAGE_ROOT`、`SHORTFILM_LOCAL_OWNER_ID`、`SHORTFILM_MAX_UPLOAD_BYTES`、`SHORTFILM_LEASE_SECONDS`、`SHORTFILM_REDISPATCH_SECONDS`；不自动加载 `.env`。默认媒体根目录为项目 `.local/media`。业务表只记录相对 objectKey，不记录开发者路径。

本机 bootstrap 使用本项目专用默认 PostgreSQL/Redis 实例。自定义数据库的迁移命令为 `services/backend/.venv/bin/alembic -c services/backend/alembic.ini upgrade head`，再运行 `services/backend/.venv/bin/python -m shortfilm.seed`。

## Compose 入口

安装 Docker Engine/Desktop 与 Compose v2 后：`make compose-bootstrap` → `make compose-dev`。外部仅绑定 127.0.0.1:5180，API、PostgreSQL、Redis 留在容器网络内。所有基础镜像已固定标签及官方多架构摘要，见 `infra/images.json`；api/worker/dispatcher 共用后端构建，数据库迁移成功才启动业务。

本机未安装 Docker，因此容器构建及启动尚未实测；M0 实际验收使用上方原生进程。媒体 Worker 当前运行文件校验；固定 FFmpeg 构建与编码器验证将在 M2/M3 加入，不宣称已有真实编码能力。

## 验证与恢复

```sh
make test       # 创建隔离测试库/临时媒体，迁移往返、并发与真实 Redis Worker 测试，结束删除测试库
make check      # Python 静态检查
make contract   # 导出 OpenAPI，重新生成 TypeScript 类型
```

测试必须有 PostgreSQL、Redis 正常运行；不会以 SQLite/eager mode 代替。首次测试曾在新建本地库验证，之后统一使用隔离库。`make test` 校验提交的 OpenAPI 没有漂移并构建前端。需要 Redis 的进程测试在 macOS/Linux 使用 FIFO 与 SIGKILL 注入中断。当前测试依赖存在两条 Starlette/httpx 上游弃用警告，均未影响行为验证。

备份前停写：等待队列任务完成并停止 `make dev`，再 `make backup` → `make restore-check`。备份保存 PostgreSQL custom dump、媒体和 SHA256 清单；拒绝有排队/运行/待对账任务的备份。恢复演练自动创建隔离数据库及新媒体目录，验证全部数据库文件引用和 API 可读性，结束清理演练库；不覆盖当前数据。备份目录 `.local/backups/` 不加入版本库。

## M0 范围

已实现：新建/分页查询/继续/改名项目，乐观锁防覆盖；真实 PNG/JPEG/WebP 上传、类型解码/大小校验、SHA256、按项目读取；Job 与 Outbox 同事务、API 幂等键、独立派发、数据库锁、尝试记录、租约心跳、旧执行者拦截、丢失队列消息恢复；三主题应用壳与配置概览。

M0 基线唯一任务类型为本地确定性的 `file.verify`，用于底座验收。不能将它的重试策略直接用于付费供应商任务。M1–M4 补齐内容/配置编辑与版本契约、生成规格、AI 适配器、任务依赖/取消/SSE/供应商对账、资产复用、媒体合成及上线身份体系。当前没有模型凭据或伪造的生成结果；初始化仅本地操作者、三类项目类型与28项未验证契约指令。


## M1 故事工作台

在项目中继续创作：保存一句话 → AI生成3个故事 → 翻页/编辑 → 导演建议 → 采用此版 → 确定此故事。正文、对话、候选、选择记录和历史版本都由 PostgreSQL 保存；浏览器只保留偏好、未保存草稿及未确认命令的幂等键。生成中离开页面不取消任务。改动正文后需重新选定，旧版始终保留。剧本/分镜按钮仅提供边界说明，本轮没有实现其生成。

默认文本配置（来自已核对的 [DeepSeek 官方接口](https://api-docs.deepseek.com/api/create-chat-completion/)）：`SHORTFILM_TEXT_ENDPOINT=https://api.deepseek.com`、`SHORTFILM_TEXT_MODEL=deepseek-v4-pro`、`SHORTFILM_TEXT_CREDENTIAL_REF=DEEPSEEK_API_KEY`、`SHORTFILM_TEXT_JSON_MODE=json_object`、`SHORTFILM_TEXT_TIMEOUT_SECONDS=120`、`SHORTFILM_TEXT_MAX_TOKENS=8192`。DeepSeek 使用非思考模式。API 与 Worker 必须继承同一份环境。

密钥可通过进程环境注入，也可停止现有开发进程后运行 `make dev-deepseek`，在终端隐藏输入密钥：只注入本次进程，不写文件、命令历史、数据库或浏览器。不要在聊天中发送密钥。普通 `make dev` 无密钥时仍可保存创意/编辑历史，但提交生成会明确阻止。配置就绪不表示真实调用已验收。

失败任务在创作工作台底部保留输入与配置；明确失败可按原配置重试。unknown 表示服务可能已受理，先到供应商核实，再勾选可能重复计费的确认重新提交；系统不伪造查询结果、不自动重发。每个原任务仅派生一个重试子任务，后续失败从子任务继续重试。

`make test-ui` 运行 Playwright 浏览器回归，独立测试端口5181，默认使用本机 Chrome；未安装 Chrome 的环境先执行 `npx playwright install chromium`（在 apps/web 下）。测试结果被 Git 忽略。M1 验收记录见 `docs/engineering/m1-story-verification.md`；真实文本密钥未注入，当前不能宣称真实故事闭环已通过。
