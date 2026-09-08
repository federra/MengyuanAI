# R5 技术实现规划

本规划服务于一个目标：**以流畅、简洁的完整创作流程提升短片生产效率，并产出用户认可的可用成片。** 系统从零建设，数据库采用 PostgreSQL；首个工程验收终点是在本地完成“一句话到真实 MP4”。质检承担内容一致性与返工控制，不是独立的产品主线。

状态：整体技术规划仍按里程碑实施；2026-09-08 已新增 M0 原生进程工程底座，具体事实见下方“本轮工程进度”。已确认的是产品范围、从零建设、PostgreSQL、本地主链优先及后续部署要求；下文技术栈是建议基线，供应商与实际并发参数需接入验证。当前交互 Demo 不作为生产代码基础，也不承担真实生成验收。产品交互以 PRD 01–10 为准，提示词交付以 [R4](/content/reference/ai-prompt-inventory.md) 为准。

## 一、实施边界与总体架构

### 1、首个可用版本

首先打通：创建项目 → 一句话 → 三个故事候选 → 选定并修改故事 → 剧本 → 分镜 → 角色/场景/道具/站位参考 → 配音与视频 → 基础剪辑 → 真实 MP4。保留剧本、分镜和参考图的人为确认；支持导演对话修改、两个节点的自动质检和按报告修复。

五个模块都建设必要的真实能力：项目保存与继续、创作主链、项目资产管理、任务追踪、模型与提示词配置。已有故事 TXT 入口在主链稳定后接入共用故事模块，不建设第二套流程。高级剪辑、剪映工程、竞品仿写、团队审批和计费暂缓。配乐先支持上传，AI 配乐等增强不阻塞首次成片。

“本地跑通”指前端、后端、数据库和执行任务的进程在本机运行；真实 AI 可以调用已配置的外部服务，不表示所有模型都在本机推理。不会把固定示例、浏览器朗读或 JSON 制作清单作为生成成功。

### 2、建议技术基线

采用一个按业务模块组织的后端，另起 Worker 执行耗时任务。这样项目、版本和任务能使用同一套事务规则，生成和编码又不会占住页面请求。首版不拆多套业务微服务。

| 层次 | 建议选型 | 职责及边界 |
|---|---|---|
| 前端 | React + TypeScript + Vite | 五模块、五工作台、编辑器、图片引用、导演对话、任务进度；构建为静态文件 |
| 后端 API | Python + FastAPI + Pydantic | 输入与输出校验、业务状态、版本确认、项目隔离、OpenAPI 契约；不直接长时间编码 |
| 数据访问 | SQLAlchemy + Alembic | 显式事务、数据库模型、可重复执行的结构迁移 |
| 数据库 | PostgreSQL | 项目、内容版本、资产元数据、任务与配置的持久记录；结构化列与 JSONB 配合 |
| 异步执行 | Celery + Redis + 独立 Worker | Redis 传递待执行消息；PostgreSQL 保存真实任务状态；AI 与媒体编码分队列 |
| 媒体存储 | StorageAdapter；本地文件卷，部署时 S3 对象存储 | 本地与远端统一使用 objectKey；文件不进入数据库，不绑定开发者绝对路径 |
| 媒体处理 | FFmpeg / ffprobe | 视频检查、末帧提取、音轨混合、字幕合成、编码和成片检查 |
| 运行交付 | Docker Compose | 本地服务编排、健康检查、持久卷；同一应用镜像进入后续测试与部署环境 |

前端采用 Vite 的 React/TypeScript 构建路径；数据库迁移采用 Alembic 的版本脚本机制。启动工程时固定兼容的运行时版本、依赖锁文件和镜像摘要，不在部署中使用浮动 `latest`。[Vite 官方指南](https://vite.dev/guide/)、[Alembic 官方教程](https://alembic.sqlalchemy.org/en/latest/tutorial.html)。

图 1：系统架构。浏览器只访问业务 API 和获授权的媒体地址，模型凭据留在服务端。

![系统架构](/content/reference/technical-diagrams/01-architecture.svg)

[查看原尺寸流程图](/content/reference/technical-diagrams/01-architecture.svg) · [Mermaid可编辑源文件](/content/reference/technical-diagrams/01-architecture.mmd)

长任务交给独立执行进程。FastAPI 官方也将重型后台计算指向 Celery 等工具；本方案额外在 PostgreSQL 保存业务状态，不依赖 Web 进程内的临时任务存活。[FastAPI 后台任务说明](https://fastapi.tiangolo.com/tutorial/background-tasks/)。

建议新工程目录为 `apps/web`、`services/backend`、`services/backend/migrations`、`contracts`、`infra`、`tests`。后端内部按 projects、creation、assets、jobs、settings、media 划分模块，API 与 Worker 共用领域规则。当前 PRD 工作区继续独立保存，不混入生产运行依赖。

## 二、数据库、接口与版本契约

### 1、PostgreSQL 数据模型

主键由服务端分配 UUID，时间统一以 `timestamptz` 保存、按用户时区展示。项目、镜头、台词、资产使用稳定 ID；排序和显示名变化不改变身份。关系、状态、时间等经常筛选的字段用独立列，报告、配置及供应商快照用带 `schemaVersion` 的 JSONB；不把整个系统塞进一个 JSON 字段。JSONB 可索引，但具体索引只为真实查询建立。[PostgreSQL JSON 类型文档](https://www.postgresql.org/docs/current/datatype-json.html)。

| 数据组 / 建议表 | 关键字段 | 必要约束和用途 |
|---|---|---|
| `principals`、`projects`、`project_types` | owner_id、name、type_id、market、style_version_id、stage、status、updated_at、cover_file_id、generation_settings | 本地种子用户；新项目画幅为空。索引 owner/status/updated_at/id 支持筛选与稳定分页 |
| `content_items`、`content_versions` | project_id、kind、batch_id、selected_version_id；item_id、revision、body、source_version_id、created_at | 故事候选按批次三份；TXT 单候选。版本只追加；唯一 item_id + revision |
| `board_versions`、`shot_versions`、`dialogue_versions` | project_id、script_version_id、revision；board_version_id、shot_id、position、prompt、duration；shot_version_id、line_id、speaker_entity_id、text、voice_version_id | 镜头/台词身份跨版本稳定；各版本内 ID 和排序唯一；台词按行存储 |
| `project_entities`、`entity_versions` | project_id、kind、entity_id、revision、name、description、voice_version_id | 集中管理全片角色、场景、道具及服饰；变更明确影响引用方 |
| `assets`、`asset_versions`、`media_files`、`shot_asset_refs` | kind、owner_id；asset_id、revision、entity_version_id、file_id；object_key、hash、mime、duration、width/height；shot_version_id、ref_id、asset_version_id、role | 覆盖七类资产。引用固定版本；已引用对象禁止物理删除；文件保存大小与校验和 |
| `conversations`、`messages`、`proposals`、`quality_reports` | project_id、stage、target_id、base_version；role、content；source_versions、proposed_output、state；issues、evidence、check_status | 对话与建议隔离；报告绑定输入；采用建议是独立事务，不直接覆盖当前内容 |
| `model_configs`、`prompt_versions`、`config_bindings` | provider、capabilities、credential_ref、revision；interaction_key、template、variables_schema、output_schema；scope、project_id、version_id | 模型与模板版本不可变；系统默认与项目覆盖分开；凭据原文不落快照 |
| `generation_jobs`、`job_attempts`、`job_dependencies`、`job_events`、`outbox` | project_id、kind、state、source_fingerprint、snapshot、idempotency_key；provider_task_id、lease_until、error；parent_job_id；event_seq | 任务持久化、可追溯与恢复；幂等键按操作者和操作范围唯一；依赖不得形成环 |
| `export_versions`、`export_clips` | project_id、revision、source_versions、settings、output_file_id、job_id；shot_version_id、video_asset_version_id、position、trim、audio_refs | 冻结导出清单；成片绑定真实文件，不只绑定供应商 URL |

图 2：主要数据关系；上表补充配置、对话、台词和文件细节。

![主要数据关系](/content/reference/technical-diagrams/02-data-model.svg)

[查看原尺寸流程图](/content/reference/technical-diagrams/02-data-model.svg) · [Mermaid可编辑源文件](/content/reference/technical-diagrams/02-data-model.mmd)

所有项目内写入校验 project_id 一致，跨项目资产复用走显式引用授权。聚合根采用 revision 乐观锁：前端提交基准版本，事务内比较；冲突返回 409，保留用户草稿。选定故事、采用建议、确认剧本和确认分镜均写入对应的确认版本，不能只存一个不带版本的“已确认”布尔值。

### 2、上游变化与结果写入

生成请求冻结故事/剧本/分镜、镜头与台词、资产、模型、提示词、风格及视频规格版本，计算 `source_fingerprint`。执行期间发生修改，结果仍可保存到历史，但不得自动成为当前可用结果。媒体的生成状态和当前适用性分开：任务可以成功，而输出对现版本为 `stale`。

影响范围按依赖计算：台词/音色修改使相应 TTS 失效；画面提示词或引用图片变化使该镜视频失效；顺序生成时连带后镜尾帧链失效；素材变化使当前导出版本待更新。改名称只更新显示，不能断开图片 ID。原素材与旧成片继续保留，重做只覆盖确认的范围。

图片引用保存为结构化片段，例如 `{type: "asset", refId, assetVersionId}`，旁边的文字片段保存正文。展示 `@名称`、点击预览、生成提交都从同一引用表解析；给供应商的图片数组按明确位置编号映射，禁止用名称或正则猜测图片。多角色台词同样用 lineId 关联音色、音频与字幕。

### 3、API 与 AI 数据契约

| 接口组（建议 `/api/v1` 前缀） | 请求与响应约定 |
|---|---|
| `GET/POST /projects`；`PATCH /projects/{id}` | 创建、筛选、排序、分页；响应含阶段、状态、更新时间和封面地址；保存携带基准 revision |
| `POST /projects/{id}/story-batches`；`POST /projects/{id}/story-imports` | 一句话生成或 TXT 导入；长任务返回 202 + jobId；导入保留原文，选题提炼单独记录任务 |
| `POST /projects/{id}/script-generations`、`board-generations`、`quality-checks` | 输入必须指向已选定/确认的精确版本；首次分镜附已确认生成规格 |
| `POST /projects/{id}/conversations/{cid}/messages`；`POST /proposals/{id}/apply` | 发送修改要求并产出建议；采用时验证 project、target、baseVersion，原子写新版 |
| `POST /assets/uploads`；`POST /assets/uploads/{id}/complete`；`POST /projects/{id}/entities` | 上传、文件验收、全片元素管理；文件验收后才成为可引用资产 |
| `POST /projects/{id}/jobs`；`GET /jobs/{id}`；`POST /jobs/{id}/cancel`、`retry` | 图像、TTS、视频等任务；指定合法 interactionKey、target 和 sourceVersions；后端决定任务类别与能力路由 |
| `GET /projects/{id}/events` | SSE 单向推送进度；携带事件序号，断线后补取事件并重新查询任务；不把连接状态当任务状态 |
| `POST /projects/{id}/exports`；`GET /exports/{id}` | 冻结剪辑与媒体版本，返回合成任务；完成后返回受控下载地址 |
| `GET/POST /settings/model-configs`、`prompt-versions`、`bindings` | 校验、版本化保存及项目覆盖；连接测试另建有记录的任务，不能假报成功 |

生成/重试/导出命令接受 `Idempotency-Key`：同一键和相同输入返回已有 jobId，同键不同输入返回冲突。服务端必须重新校验前置确认、能力、资产和权限；不能信任客户端传来的“已通过”。OpenAPI 作为前后端契约源，生成 TypeScript 客户端并做契约测试。前端本地存储只承载 UI 偏好与待保存草稿，正式项目数据以服务端为准。

文本与报告建议继续使用 **JSON + JSON Schema + 服务端语义校验**。若供应商支持结构化输出则开启；不支持时解析文本 JSON，校验失败将错误路径反馈给模型，限定两次修正，仍不合格则明确失败。合法 JSON 不等于业务有效；不能靠提示词承诺代替 ID、版本和引用校验。

分镜质检沿用 R4 的 `schemaVersion: 2`、`scriptId`、`baseBoardVersion`、`issues`、`proposedShots`，请求外层补全精确 sourceVersions。`proposedShots` 必须是完整镜头集合，每段台词均有稳定 ID；一键修复不得擅自增删镜头/台词。需要结构调整时先由用户在编辑器操作。服务端事务校验全部内容后写新版，再安排复检；过期报告返回冲突，不能部分应用。剧本修复上下文包含原故事、当前剧本、完整报告及用户要求。

新增故事/镜头由后端将模型的临时标识映射为正式 UUID；编辑与修复只能使用已发给模型的合法 ID。媒体供应商返回的 URL 必须下载、校验并存入自有存储，不能长期依赖临时 URL。TTS 的音色、语速以及视频尺寸、参考图等使用适配器参数；不支持自由提示词的接口，不虚构这一能力。

## 三、五个模块的流程图与实现规则

### 1、项目模块

图 3：项目从创建到完成，进度由内容与成片状态驱动。

![项目模块流程](/content/reference/technical-diagrams/03-projects.svg)

[查看原尺寸流程图](/content/reference/technical-diagrams/03-projects.svg) · [Mermaid可编辑源文件](/content/reference/technical-diagrams/03-projects.mmd)

项目卡封面来自本项目已选媒体或成片截帧；没有时显示占位，不用无关图库图片冒充。统计由真实项目查询计算。编辑时间来自用户内容/配置保存，不被轮询进度刷新。重新编辑已完成项目后，旧成片留存，当前项目恢复创作中；旧版本合成任务晚到不能将新版本标为已完成。

### 2、创作模块

图 4：两条入口共用五阶段；实线为首个本地工程主链，虚线为随后接入的 TXT 入口。

![创作主流程](/content/reference/technical-diagrams/04-creation.svg)

[查看原尺寸流程图](/content/reference/technical-diagrams/04-creation.svg) · [Mermaid可编辑源文件](/content/reference/technical-diagrams/04-creation.mmd)

图中复检回到工作台检查流程，不是无条件重新生成整份故事/剧本/分镜。助手按 project + stage + target 保存对话；流式文字仅展示草稿，完整输出经校验后进入建议区，用户采用才改变当前版本。界面统一少量主操作，质检在导演助手中提供常驻入口，生成中可继续查看历史和其他镜头。

图 5：分镜内部的参考、音频、顺序视频与成片依赖。

![分镜媒体依赖](/content/reference/technical-diagrams/05-media-chain.svg)

[查看原尺寸流程图](/content/reference/technical-diagrams/05-media-chain.svg) · [Mermaid可编辑源文件](/content/reference/technical-diagrams/05-media-chain.mmd)

独立生成没有前镜依赖；顺序生成将“前镜视频成功 → 提取末帧成功 → 后镜可提交”保存为任务依赖，不能由浏览器定时器驱动。第二镜及以后同样先检查文件和源版本再放行。第一镜没有尾帧输入；供应商不支持所需多图或首帧约束时在提交前阻断，不能悄悄丢图。

镜头表支持多角色多段台词及增删排序，TTS 按 lineId 独立生成和重试。分镜视频默认作为画面轨，配音来自独立音频；原视频声音是否保留在导出设置中明确，避免重复人声。字幕时间取 TTS 时间戳或对齐工具结果，不让大模型猜时间。配音长于镜头时要求调整镜头时长、语速或剪辑，不能静默截断。

导出前冻结镜头顺序、裁剪范围、媒体版本、字幕和音轨。合成按统一像素尺寸、帧率及采样规格处理，禁止通过拉伸掩盖画幅差异；裁切/留边由设置决定。末帧、字幕和编码是确定性处理，可使用 FFmpeg；首版建议 H.264/AAC 的 MP4，并在固定容器构建中验证编码器可用性。[FFmpeg 官方文档](https://ffmpeg.org/ffmpeg.html)。

合成成功须同时满足：进程正常退出、文件落盘/入库、ffprobe 检查存在有效视频流与预期音轨、时长及尺寸符合清单、抽查可解码且浏览器可播放。随后返回下载地址并更新当前项目完成状态。若期间源版本变化，只登记历史导出成功，当前作品保持待更新。

### 3、资产模块

图 6：资产从描述/上传到可复用版本，修改影响可追踪。

![资产模块流程](/content/reference/technical-diagrams/06-assets.svg)

[查看原尺寸流程图](/content/reference/technical-diagrams/06-assets.svg) · [Mermaid可编辑源文件](/content/reference/technical-diagrams/06-assets.mmd)

本地文件放在配置的持久卷，API 与 Worker 通过同一 StorageAdapter 读写。数据库只保存 objectKey、文件属性和校验和；临时工作目录用于编码，完成后清理。线上切换到 S3 后由服务端签发短时上传/下载地址；签名地址具有访问能力，不能写入长期日志或公开分享。[S3 预签名地址说明](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)。

角色、场景与道具管理编辑项目元素；资产库管理可复用版本，两者避免混为同一份可变数据。引用中的素材禁止直接删除；先替换关联，未引用对象才进入延迟清理。风格与声音可以只有结构化设定，不强制包含媒体文件。上传必须检查实际文件类型、解码结果和大小；TXT 保留完整原文，超出上下文容量明确提示，后续分章不能静默截断。

### 4、任务记录模块

图 7：任务从提交到结果，覆盖不确定状态、重试和取消。

![任务执行与恢复](/content/reference/technical-diagrams/07-jobs.svg)

[查看原尺寸流程图](/content/reference/technical-diagrams/07-jobs.svg) · [Mermaid可编辑源文件](/content/reference/technical-diagrams/07-jobs.mmd)

状态至少包括 waiting_dependency、queued、running、waiting_provider、unknown、succeeded、failed、cancel_requested、cancelled；业务适用性另存 current/stale。进度仅显示可证实的阶段，供应商没有进度就显示处理中，不编造百分比。用户刷新或关闭页面不影响执行，重新打开从数据库恢复。

Outbox 是与 Job 在同一数据库事务写入的待派发记录。独立派发器把 jobId 送到 Redis，发送后标记；重复投递由数据库任务锁和状态检查吸收。Worker 更新租约与心跳；恢复扫描处理过期租约、漏发消息和长期等待的供应商任务。网络请求不放进数据库长事务。

队列与 Worker 应按“消息可能重复”设计。Celery 文档强调任务幂等及重试行为；`acks_late` 不是防重复收费的保证。每次尝试保存供应商任务 ID 和可用的幂等键，超时先查询原任务，无法确认时保留 unknown 并由用户决定是否再次付费提交，不能盲目自动重发。[Celery 任务与幂等说明](https://docs.celeryq.dev/en/stable/userguide/tasks.html)。

建议初始并发：文本 2、图像 2、视频 1、TTS 2、合成 1，均为可配置起点，按供应商限额与本机实测调整。明确可重试的网络/限流错误采用退避，自动最多两次；鉴权、能力不匹配、业务校验错误立即失败。取消不能承诺供应商停止计费：已提交任务尽力取消，晚到结果归档，依赖链停止且不自动采用。单段配音失败不重做其他成功段。

### 5、系统设置模块

图 8：配置从编辑到一次任务的不可变快照。

![系统设置流程](/content/reference/technical-diagrams/08-settings.svg)

[查看原尺寸流程图](/content/reference/technical-diagrams/08-settings.svg) · [Mermaid可编辑源文件](/content/reference/technical-diagrams/08-settings.mmd)

模型适配器提供 text、image、video、tts 能力接口，并声明支持的尺寸、时长、参考图数量、首帧、音色与语言、取消及幂等能力。连接成功不等于所有能力可用；每种能力用样例请求验证。实例地址由服务端限制与校验，供应商输出媒体只从允许来源获取，避免任意地址访问本机或云内网。

R4 的 P01–P28 使用独立 interactionKey 绑定提示词/模型。首先接入 P01–P08、P11–P13、P15、P17、P18、P25、P27、P28；P26 随 TXT 入口接入。P10 资产提取先可人工维护，其他增强按 R4 推进。写作、剧本和分镜 Skill 作为带版本的指令包导入，校验变量与输出 Schema，不执行任意脚本。质检模型可独立配置，不要求与创作模型相同。

本地凭据通过未入版本库的环境变量或受控密钥文件注入，配置只保存 credential_ref；上线换成密钥管理服务。预览、日志、导出及浏览器不回传凭据原文。系统输出默认值只在第一次分镜设置时建议，用户确认后成为项目版本；切换 UI 主题只影响界面，不影响视频风格或任务快照。

## 四、本地运行、迁移部署与上线准备

### 1、本地完整运行环境

规划 Compose 服务：web、api、worker-ai、worker-media、dispatcher、postgres、redis。api 与 Worker 共用后端镜像，媒体 Worker 使用包含固定 FFmpeg 构建的镜像。PostgreSQL、Redis 和媒体使用独立持久卷，启动时健康检查；Alembic 迁移作为单独步骤执行，成功后才启动业务。首次种子数据只有本地操作者、项目类型和提示词模板，不灌入伪造的生成结果。

新工程提供 `make bootstrap`（校验环境、启动依赖、迁移与种子）、`make dev`、`make test`、`make backup`、`make restore-check`。这些命令现已在仓库根目录实现，独立 PRD 工作区仍不承担生产运行。数据库与服务只绑定本机；本地模式不能直接暴露公网。

### 2、从本机到部署环境

图 9：迁移对象包括应用、数据库和媒体文件；不依赖本机路径。

![迁移部署流程](/content/reference/technical-diagrams/09-deployment.svg)

[查看原尺寸流程图](/content/reference/technical-diagrams/09-deployment.svg) · [Mermaid可编辑源文件](/content/reference/technical-diagrams/09-deployment.mmd)

第一阶段部署可用单台服务器加持久存储，按需迁至托管 PostgreSQL/S3、独立 Worker。Compose 支持用环境覆盖文件调整生产设置；部署版去掉源代码热挂载，使用固定镜像、重启策略和独立密钥配置。[Docker Compose 部署说明](https://docs.docker.com/compose/how-tos/production/)。不把 Kubernetes 作为首次上线前提。

本地迁移到测试环境时：暂停新生成、等待或记录在途任务 → 备份数据库及媒体清单 → 恢复数据库 → 按原 objectKey 复制媒体并核对校验和 → 注入新环境凭据与地址 → 回归后开放写入。首次搬迁先停写以避免数据库与媒体不一致；供应商在途任务必须对账，不能在新旧环境同时重发。Redis 可从 PostgreSQL 重建待派发工作，不复制它来代替数据库恢复。

每次数据库变更提交 Alembic 迁移，在空库和上一版本样本库都测试。采用先兼容新增、再切换读写、最后清理旧结构的发布方式；应用回滚不等于自动降级数据库，破坏性变更必须有备份恢复方案。上线前至少完成一次数据库加媒体的恢复演练。

### 3、公开上线前的必要门槛

本地先使用种子用户及固定身份上下文，所有业务数据从第一天关联 owner/project。公开上线前接入登录会话和资源级访问校验，覆盖项目、任务、对话、资产、下载与 SSE；复杂角色权限仍可延期。不得保留可被公网使用的本地身份绕过开关。

线上只公开 HTTPS 入口，数据库、Redis 和内部存储接口走私网；设置上传大小、生成并发及成本上限，配置密钥轮换。日志使用 projectId/jobId/attemptId/traceId 关联，正文与密钥脱敏；记录排队时长、供应商时长、错误率、重复生成和费用（估算与账单分开），对任务积压、磁盘不足、凭据失败、备份失败设置告警。

上线容量、响应目标、可接受恢复时长与数据丢失窗口由本地试用量和预算确定，不能用未经实测的数字承诺可用性。首轮部署参数、供应商价格/限额、备份保留周期在上线前形成配置清单并实际验证。

## 五、开发顺序与验收清单

### 1、按可验收成果推进

| 阶段 | 交付内容 | 退出条件 |
|---|---|---|
| M0 工程底座 | 新工程、前后端契约、PostgreSQL迁移、文件存储、配置、持久任务与恢复 | 空环境可启动；保存项目后重启仍可继续；队列重复投递不重复落库 |
| M1 内容主链 | 一句话三故事、版本与导演对话、剧本/分镜生成、质检修复、生成规格 | 真实文本模型走通到确认分镜；非法JSON与过期建议被拒；人工修改可保存 |
| M2 镜头生产 | 全片元素、参考图确认、逐台词TTS、视频适配、尾帧顺序链 | 真实图片/音频/视频入库；至少三镜连续生成；中镜失败能恢复而不重做成功前镜 |
| M3 本地产品验证 | 基础剪辑、字幕/音轨、真实MP4、任务记录与跨会话恢复 | 由用户从一句话独立完成可下载成片，检查内容与音画；首次产品里程碑在此完成 |
| M4 共用入口与部署 | TXT单选题、资产复用完善、部署配置、身份隔离、备份恢复和监控 | TXT复用主链；新环境部署成功；通过上线门槛后再对外开放 |

M0–M2 是工程中间成果，不能宣称产品已跑通。提示词工程与相应生成接口一起验收；供应商选择优先满足端到端能力组合，不以模型名称或宣传指标决定架构。每阶段发现的问题优先修复当前主链，不先扩展非主线模块。

### 2、首个真实成片验收

| 验收项 | 操作与通过标准 |
|---|---|
| A01 完整作品 | 同一项目从一句话生成三种故事方向，选定其一，经剧本/分镜/媒体到可播放、可下载MP4；无人工在后台拼接数据 |
| A02 人工控制 | 对话建议未采用时不改正文；用户修改、选定、确认均有版本；过期修复返回冲突且保留草稿 |
| A03 真实素材 | 至少一镜含两角色多段台词，四类参考可预览并准确映射到提交数据；TTS是实际音频文件 |
| A04 连续生成 | 至少三镜；后镜输入能追溯到前镜指定视频的末帧文件；注入第二镜失败后第三镜等待，恢复不重复生成第一镜 |
| A05 持久恢复 | 生成中刷新、关闭页面、重启Worker后可恢复；外部受理超时进入对账状态；重复点击不重复提交同一任务 |
| A06 成片有效 | MP4含预期画面、音轨、字幕与实际时长；检查无空白镜头、漏台词或静默截断；已过期媒体不能进入新成片 |
| A07 环境迁移 | 在新目录或另一部署环境恢复数据库与媒体，项目可打开、素材可读取并继续生成，无开发者绝对路径依赖 |

试用样本建议覆盖营销短片和剧情短片各一例，再做一次故障恢复演练；可用 30–90 秒短片作为首批测试尺度，不把它设为项目创建限制。自动测试覆盖数据库事务/版本、API契约、依赖恢复、媒体编码；真实供应商集成测试单独记录模型、提示词版本、耗时和成本，模拟测试通过不代替真实调用验收。

### 3、产品可用性与工程准备

试用记录以项目为单位：从输入到下载的总耗时、人工操作时间、供应商等待时间、人工返工与重复生成次数、外部补救环节、实际费用和成片是否被用户接受。可用成片完成率为“用户认可且技术验收通过的项目数 / 已开始并纳入本轮试用的项目数”，中途放弃单独标原因；不把一次任务成功率当整体生产效率。与同类任务的原流程基线比较后，再决定下一阶段优化重点。

实施前需要实际配置一组文本、图像、视频与 TTS 服务及凭据，验证多图/首帧、音色、异步查询、输出下载等能力；这些信息尚未提供，不影响本规划完成。首版路线和数据边界已经明确，下一步工程工作从 M0 开始，供应商验证与 M1 接入同期完成。

## 本轮工程进度（2026-09-08）

M0 新工程位于仓库根目录 `apps/web`、`services/backend`、`contracts`、`infra`、`scripts`、`tests`。使用本规划建议的 React/TypeScript/Vite、FastAPI、SQLAlchemy/Alembic、PostgreSQL、Celery/Redis 基线。交互 Demo 与阅读器保持独立。

本轮真实能力为项目持久保存/继续编辑/版本冲突、PNG/JPEG/WebP 上传与相对 objectKey 存储、固定本地 owner 隔离、环境配置及28项未验证契约指令种子、数据库 Job+Outbox、独立派发与 Worker、重复消息幂等、心跳租约与旧执行者拦截。使用 `file.verify` 文件校验任务验收底座；该任务不是 AI 生成，不会把项目标为成片完成。

根目录 `make bootstrap` → `make dev`；工程页面 5180、API 8010、PostgreSQL 55432、Redis 56379，避免占用其他项目的 5173/8000。`make test` 在临时隔离库验证迁移、事务及真实 Redis/Worker 故障；`make backup` / `make restore-check` 提供停写备份与隔离恢复。具体实测记录维护在仓库 `docs/engineering/m0-verification.md`，使用方法见根目录 README。

Compose 与镜像摘要已交付；当前机器未安装 Docker，容器构建/启动尚未验收。FFmpeg、供应商连接/对账、完整配置编辑、任务依赖/取消/SSE、内容和资产版本领域仍按 M1–M4 推进。本轮没有修改 A01–A07 的真实成片通过标准，也不表示完整产品已跑通。


## M1 故事子阶段进度 · 2026-09-08

用户本轮要求先保存 M0 Git 基线，再实施故事闭环。M0 标签为 `m0-baseline-20260908`，原始提交 `cf2d2c6`；审查及再次验证记录见工程 `docs/engineering/m0-baseline-review.md`。本轮没有将整个 M1 或 A01–A07 标为完成。

工程新增 `content_items/content_versions/story_selections/messages/proposals` 及增量迁移：创意保存、一批三候选、历史分页、人工修改、精确版本选择、导演多轮建议、采用冲突及旧版留存。AI Worker 接收文本队列，结果与任务成功同事务写入；建议采用前不改正文，修改选定故事后取消旧确认。上游创意变化后，旧候选仍可查看并标识来源过期，用户可以明确重新选定。

DeepSeek 适配器默认使用 `https://api.deepseek.com` 的 `deepseek-v4-pro`（服务端可覆盖）。使用 JSON Output、非思考模式、8192 token 上限；仅凭据引用进入快照。正文/结构错误最多修正两次，超时、5xx及执行中断进入 unknown，不自动重发；用户确认可能重复计费后创建一个重试子任务，旧记录保留。没有可据此宣称的供应商查询对账能力，unknown 只能人工核实后决定。模型参数、P01/P02 revision 2、源版本、输入及调用耗时/usage/request ID 留存。

`make test` 覆盖隔离 PostgreSQL、真实 Redis/Worker 中断恢复；`make test-ui` 使用独立5181浏览器页面与显式 API 替身检查前端冲突草稿、刷新幂等、建议采用和主题；它们都不代替真实供应商验收。本地数据库迁移前已停写、备份并完成独立恢复演练。用户确认 `DEEPSEEK_API_KEY` 尚未注入；真实模型故事闭环仍待最后验收。剧本、分镜、质检修复、TXT入口、完整模型配置编辑与成片能力继续按原计划实施。
