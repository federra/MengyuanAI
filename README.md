# AI短片工坊

从零建设的 PC Web 短片创作系统。M0 提供工程底座，M1 已接入创意、故事、剧本、分镜的文本内容链、配置资源与 DeepSeek 适配器；已通过真实DeepSeek内容链至确认分镜及隔离故障回归。M2 已完成真实参考图/TTS/三镜视频、前镜尾帧和中镜故障恢复验收，详见 [M2 最终验收](docs/engineering/m2-final-verification.md)；音轨/字幕合成 MP4 继续按 M3 实施。需求与交互 Demo 保存在独立的 `interaction-prd-workspace/`，不参与应用构建。

## 工程结构

```text
apps/web/                  React + TypeScript + Vite 五模块应用壳
  src/generated/api.d.ts   从 OpenAPI 生成的类型，配合 openapi-fetch 客户端
services/backend/
  src/shortfilm/
    projects/              项目保存、owner 隔离、revision 冲突
    creation/              四阶段内容版本、建议质检/修复、DeepSeek 与恢复
    assets/                M2 资产版本领域边界
    media/                 StorageAdapter、图片验收与受控读取
    jobs/                  事务入队、dispatcher、Celery、租约恢复
    configuration/         资源版本、模型路由、场景模板、方法及规格快照
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

本机未安装 Docker，因此容器构建及启动尚未实测；M0 实际验收使用上方原生进程。媒体 Worker 已支持真实媒体校验、供应商任务和 FFmpeg 尾帧提取；M3 成片音轨/字幕合成尚未实现。

## 验证与恢复

```sh
make test       # 创建隔离测试库/临时媒体，迁移往返、并发与真实 Redis Worker 测试，结束删除测试库
make check      # Python 静态检查
make contract   # 导出 OpenAPI，重新生成 TypeScript 类型
```

测试必须有 PostgreSQL、Redis 正常运行；不会以 SQLite/eager mode 代替。首次测试曾在新建本地库验证，之后统一使用隔离库。`make test` 校验提交的 OpenAPI 没有漂移并构建前端。需要 Redis 的进程测试在 macOS/Linux 使用 FIFO 与 SIGKILL 注入中断。当前测试依赖存在两条 Starlette/httpx 上游弃用警告，均未影响行为验证。

备份前停写：等待队列任务完成并停止 `make dev`，再 `make backup` → `make restore-check`。备份保存 PostgreSQL custom dump、媒体和 SHA256 清单；拒绝有排队/运行/等待供应商等活动任务的备份；历史 unknown 原样保存并列出待核实任务，恢复后不会自动重投。恢复演练自动创建隔离数据库及新媒体目录，验证全部数据库文件引用和 API 可读性，结束清理演练库；不覆盖当前数据。备份目录 `.local/backups/` 不加入版本库。

## M0 范围

已实现：新建/分页查询/继续/改名项目，乐观锁防覆盖；真实 PNG/JPEG/WebP 上传、类型解码/大小校验、SHA256、按项目读取；Job 与 Outbox 同事务、API 幂等键、独立派发、数据库锁、尝试记录、租约心跳、旧执行者拦截、丢失队列消息恢复；三主题应用壳与配置概览。

M0 基线唯一任务类型为本地确定性的 `file.verify`，用于底座验收。不能将它的重试策略直接用于付费供应商任务。M0 原始基线保留为 Git 标签 `m0-baseline-20260908`。当前增量已提供内容/配置版本、生成规格与文本适配器；任务依赖/取消/SSE/供应商对账、资产复用、媒体合成及上线身份体系继续按后续计划实施。初始化不生成内容，仅创建操作者、项目类型、具名方法和提示词契约资源。


## M1 内容工作台与配置

一句话 → 3个故事 → 选择或修改采用 → 剧本 → 分镜。每阶段支持正文保存、导演建议预览/采用、历史版本和独立质检；修复生成建议，采用后才追加版本。质检有问题、未完成或失败均可保留当前版本继续，来源冲突和不合法内容仍需修正。上游修改标记下游过期；分镜重排保留镜头/台词 ID，图片引用使用真实项目文件。M2真实媒体链已通过；M3已实现本地真实导出，用户独立完整流程待验收，TXT入口保留在后续范围。

模型/提示词/风格三 Tab 直接打开配置：四类模型默认与环节覆盖，场景模板与资产资源库共用，Skill/提示词具名方法从故事环节开始选择；创意助手不选方法。项目画幅/分辨率、方法、模板和模型的最终版本在提交任务时冻结。环境变量仅提供首次初始化默认值，后续在设置保存实际路由。

正文、对话、候选、确认、报告与历史版本由 PostgreSQL 保存；浏览器只保留偏好、未保存草稿及未确认命令的幂等键。离开页面不会取消任务，冲突保留草稿并允许读取最新基准，响应丢失可重用同一命令身份恢复。

默认文本配置（来自已核对的 [DeepSeek 官方接口](https://api-docs.deepseek.com/api/create-chat-completion/)）：`SHORTFILM_TEXT_ENDPOINT=https://api.deepseek.com`、`SHORTFILM_TEXT_MODEL=deepseek-v4-pro`、`SHORTFILM_TEXT_CREDENTIAL_REF=DEEPSEEK_API_KEY`、`SHORTFILM_TEXT_JSON_MODE=json_object`、`SHORTFILM_TEXT_TIMEOUT_SECONDS=120`、`SHORTFILM_TEXT_MAX_TOKENS=8192`。DeepSeek 使用非思考模式。API 与 Worker 必须继承同一份环境。

推荐在“系统设置 → 模型 → 生文”保存模型配置，再在“API 密钥与连接”输入并保存密钥，最后测试已保存的连接。密码不会回显或写入浏览器草稿；测试是一笔短文本调用，会消耗供应商用量，不能代替M1完整内容链验收。

页面凭据认证加密保存在独立的 `.local/credentials/`，目录0700、文件0600，API与Worker共享读取，页面保存后无需重启。主密钥与加密文件均不进入数据库、媒体、普通备份或Git；该保护依赖本机账户权限，不能抵御同账户恶意程序。丢失此目录或移机恢复后请重新在页面录入，勿在聊天中发送密钥。`SHORTFILM_CREDENTIAL_ROOT` 可指定独立目录，不能以普通媒体备份代替凭据恢复。

已保存凭据优先于同名环境变量，且绑定保存时的服务地址；地址改变需重新保存对应密钥，系统不回退并误发旧密钥。仍支持进程环境注入及 `make dev-deepseek` 的终端隐藏输入方式。普通 `make dev` 无可用凭据时允许保存创意/编辑历史，但阻止提交生成。

失败任务在创作工作台底部保留输入与配置；明确失败可按原配置重试。unknown 表示服务可能已受理，先到供应商核实，再勾选可能重复计费的确认重新提交；系统不伪造查询结果、不自动重发。每个原任务仅派生一个重试子任务，后续失败从子任务继续重试。

`make test-ui` 运行 Playwright 浏览器回归，独立测试端口5181，默认使用本机 Chrome；未安装 Chrome 的环境先执行 `npx playwright install chromium`（在 apps/web 下）。测试结果被 Git 忽略。最新工程验收见 [M0/M1 验收记录](docs/engineering/m0-m1-verification.md)，原故事子阶段记录保留在 `docs/engineering/m1-story-verification.md`。用户已通过页面保存凭据，真实DeepSeek M1验收通过；实际失败、必要修复、版本/恢复证据与边界见 [M1真实验收](docs/engineering/m1-real-verification.md)。

## M2 实施记录（早期状态，最终验收见下文）

开发分支 `codex/m2-media-chain` 以 `m1-baseline-20260908` 为回退基线。已加入项目角色/场景/道具的版本API与管理弹窗、上传参考图的来源和人工确认、FFmpeg音视频探测及末帧工具。分支已加入 Seedream、MiniMax TTS、Seedance 适配器、逐台词音色绑定、稳定图片引用替换、媒体持久任务与顺序尾帧链。用户选定视频模型 `doubao-seedance-2-0-mini-260615`；页面预设只填配置草稿，密钥沿用密码框加密保存。适配器和替身回归不代表真实供应商验收；用户已批准并完成停写备份、隔离恢复、M2迁移和服务重启；既有行/文件哈希一致。三类媒体默认模型配置已保存，密钥待用户页面录入。早期定向测试误写3项目/1测试图的事实及补救见M2验收记录。

新增媒体处理测试要求PATH中有 `ffmpeg` 和 `ffprobe`；本机安装的Homebrew版本为9.0.1_1。新环境先安装FFmpeg再运行 `make test`。依赖边界见 [媒体运行说明](docs/engineering/m2-media-runtime.md)；增量、依赖和验收清单见 [M2实施计划](docs/engineering/m2-implementation-plan.md)，完成事实以 [M2验收记录](docs/engineering/m2-verification.md) 为准。

测试只允许通过 `make test` 使用临时数据库和媒体目录；直接pytest缺少隔离配置会在导入测试前拒绝运行。

## 公网单人试用部署

当前没有多用户登录体系，公网部署必须在HTTPS反向代理上对页面、API、媒体统一认证，后端和数据库只能监听本机。设置 `SHORTFILM_PUBLIC_ORIGIN` 为准确HTTPS访问来源，以允许页面配置并拒绝跨站写入；此变量本身不提供认证，不能代替入口保护。部署与数据迁移证据见 [服务器部署记录](docs/engineering/server-deployment.md)。


## M2完成与M3本地试用检查点

M2真实图像、逐句配音和三镜前镜尾帧链已验收，最新事实见[M2最终记录](docs/engineering/m2-final-verification.md)。早期等待密钥、未验收描述仅为历史。M3从完整9c077d4建立本地标签m2-baseline-20260909及分支codex/m3-real-export；本轮未合并、推送或部署。

“创作 → 导出”现提供追加版本剪辑、排序/时长、配音/原声/上传配乐、字幕、真实预览与MP4下载。导出继承项目规格；台词超长、无效素材或过期来源会明确阻断，AI质检建议不强制。失败保留剪辑可重试，Worker中断恢复只重算本地合成。真实成功且输入仍当前才标项目完成。

运行继续使用make dev；需FFmpeg、ffprobe及中文字体。本机使用Arial Unicode，Linux安装fonts-noto-cjk，或设置SHORTFILM_SUBTITLE_FONT为可读字体路径。容器配置补充字体依赖，但未构建或部署容器。数据库迁移新增export_versions/export_commands，M2既有数据与35个文件哈希核对未变。回退代码不自动降级数据库，恢复数据需使用对应停写备份。

已有真实素材合成可本地播放下载，新增供应商费用0元；这不代表用户一句话完整流程已验收。工程、成片、备份与边界见[M3验收记录](docs/engineering/m3-verification.md)，操作和待批准用量见[用户独立试用](docs/engineering/m3-user-acceptance.md)。

## V12/V13 本地增量检查点（2026-09-10）

隔离分支`codex/v12-v13-ui-alignment`已实现故事数量1～3、最新项目/创意布局、六列分镜逐句TTS、单镜覆盖/独立并发、事务整表JSON导入和四主题公共布局。工程207项后端与40项页面回归通过，供应商调用0；生产服务升级仍待明确授权，用户视觉验收未通过。事实与边界见[增量验收记录](docs/engineering/v12-v13-verification.md)，迁移、最新停写备份和回退步骤见[本地升级方案](docs/engineering/v12-v13-local-upgrade.md)。

独立视频供应商并发默认2，可用`SHORTFILM_MEDIA_VIDEO_CONCURRENCY`设置1～8；未知受理状态保守占位，原任务对账恢复，不盲目重发。导入成功后事务outbox启动建议质检，会使用已配置文本模型；质检失败不撤销导入。不要为UI回归自动点击生成或导入提交。
