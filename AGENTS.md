# AI短片工坊 · 项目文档导航

本文件适用于项目根目录及子目录，用于定位需求、交互原型与技术规划。产品名为 **AI短片工坊**；目录名 MengyuanAI 不代表需要兼容或复用旧系统。

中文回复以“跪呈南哥批阅：”开头并换行；结论先行，表达简洁，避免重复与不必要的标题。按当前用户授权推进，不因常规文档维护重复要求确认。

## 一、先读什么

1. 理解产品：阅读 [产品定义与目标](interaction-prd-workspace/prd/01-product-definition.md) 和 [用户故事与旅程](interaction-prd-workspace/prd/03-user-stories-and-journey.md)。
2. 开始工程开发：阅读 [R5 技术实现规划](interaction-prd-workspace/reference/technical-implementation-plan.md)，重点看架构、版本契约、M0–M4 开发顺序和 A01–A07 验收。
3. 修改某个功能：按下表读取对应正式 PRD；涉及界面同时读 R1/R2，涉及 AI 同时读 R4。
4. 查找页面、标注和跳转：[interaction-prd.json](interaction-prd-workspace/interaction-prd.json) 是模块、页面 ID、文件路径、关系和展示状态的唯一索引，勿凭显示名称猜路径。

最新用户明确决策优先于旧文档；正式 PRD 规定当前产品行为，R1/R2 提供设计与交互依据，R4 提供提示词契约，R5 提供实施方案。R5 中“建议基线”不能当作用户已确定的全部技术选型；原型演示也不能作为真实服务已实现的证据。发现不一致时明确指出并同步相关文档，不用历史材料覆盖最新需求。

## 二、按任务检索

| 要查的问题 | 文档入口 |
|---|---|
| 产品目标、范围、成功标准、原型边界 | [01 产品定义与目标](interaction-prd-workspace/prd/01-product-definition.md) |
| 用户角色与需求 | [02 用户与需求分析](interaction-prd-workspace/prd/02-users-and-needs.md) |
| 两条入口、用户故事、跨阶段规则 | [03 用户故事与旅程](interaction-prd-workspace/prd/03-user-stories-and-journey.md) |
| 项目创建、项目库与创作入口 | [04 项目与创作入口](interaction-prd-workspace/prd/04-project-workspace.md) |
| 模型、提示词、音频、风格和视频默认配置 | [05 模型与提示词配置](interaction-prd-workspace/prd/05-ai-configuration.md) |
| 创意、故事候选、导演对话、剧本与质检 | [06 创意引导与故事剧本](interaction-prd-workspace/prd/06-story-development.md) |
| 分镜表、多段台词、图片引用、修复与配音 | [07 分镜与内置质检](interaction-prd-workspace/prd/07-storyboard-review.md) |
| 资产库、风格、角色/场景/道具/站位图 | [08 风格模板与参考素材](interaction-prd-workspace/prd/08-visual-assets.md) |
| 镜头生成、前镜尾帧、任务状态与快照 | [09 镜头视频与生成任务](interaction-prd-workspace/prd/09-video-generation.md) |
| 音轨、字幕、基础剪辑、真实成片导出 | [10 声音、基础剪辑与导出](interaction-prd-workspace/prd/10-finishing-export.md) |
| 视觉规范、字号和 UI 主题 | [R1 视觉设计规范](interaction-prd-workspace/reference/DESIGN.md) |
| 原型演示路线、公共组件和异常状态 | [R2 主线原型与组件状态](interaction-prd-workspace/reference/components-and-states.md) |
| AI 交互点、模板变量、输出结构、提示词验收 | [R4 提示词定制清单](interaction-prd-workspace/reference/ai-prompt-inventory.md)；[机器清单 JSON](interaction-prd-workspace/reference/ai-prompt-inventory.json) |
| 前后端、PostgreSQL、任务执行、接口、部署和实施里程碑 | [R5 技术实现规划](interaction-prd-workspace/reference/technical-implementation-plan.md) |
| 架构图、数据关系及五模块流程图 | [技术图表目录说明](interaction-prd-workspace/reference/technical-diagrams/README.md)；同目录 `.mmd` 为源文件，`.svg` 为展示文件 |
| 定型依据、当前范围与待验证问题 | [定型摘要](interaction-prd-workspace/shaping/06-shaped-brief.md)、[MVP 范围](interaction-prd-workspace/shaping/03-scope.md)、[待确认问题](interaction-prd-workspace/shaping/05-open-questions.md) |
| 已做过的验证及其边界 | [技术规划验收](interaction-prd-workspace/reference/verification-v7-technical-plan.md)、[主题验收](interaction-prd-workspace/reference/verification-v6-themes.md)、[工作台验收](interaction-prd-workspace/reference/verification-v5.md)；其他记录按 `reference/verification-*.md` 检索 |

历史输入见 [输入材料](interaction-prd-workspace/shaping/00-intake.md)，旧版文件集中在 `interaction-prd-workspace/reference/history/`，仅在追溯明确历史决策时读取。隐藏的 [00 板块计划](interaction-prd-workspace/prd/00-plan.md) 是过程产物；[R3 参考视频再创作](interaction-prd-workspace/reference/deferred-video-remix.md) 是延期方向，不能自动纳入当前开发范围。

## 三、当前必须记住的决策

- 核心目标是用流畅、简洁的完整流程提升短片生产效率与成片质量。质检是辅助机制，不把外部复制粘贴作为首要产品问题。
- 系统从零建设，数据库采用 PostgreSQL；首先在本地跑通“一句话 → 故事 → 剧本 → 分镜 → 参考图/配音 → 视频 → 真实 MP4”。已有故事 TXT 入口保留在产品范围中，随后复用主链。工程要兼顾后续部署，不能以浏览器缓存充当正式数据存储。
- 左侧五模块为项目、创作、资产、任务记录、系统设置；创作顶部五阶段为创意、故事、剧本、分镜、导出。项目创建不预设画幅或固定时长，画幅/分辨率/模型在首次分镜生成时确认。
- AI 建议由用户采用后才更新内容；保存源版本、稳定镜头/台词/图片 ID、配置快照和历史结果。上游修改明确标记下游过期。顺序视频依赖前镜真实视频末帧，失败时不跳镜。
- 仓库保留独立交互 PRD 与 Demo，并已新增 M0 工程底座：React/TypeScript 前端、FastAPI、PostgreSQL、文件存储与持久任务。真实 AI 与编码尚待 M1–M3 实施。UI 有浅色、深色、晴空蓝三主题，UI 主题与成片视觉风格互不影响。

## 四、文件位置与维护方式

PRD 工作区为 `interaction-prd-workspace/`：`prd/` 存正式需求，`shaping/` 存定型依据，`reference/` 存设计/技术/提示词资料，`prototypes/pages/` 存独立原型页，`prototypes/shared/` 存共享样式与交互，`annotations/` 存页面标注。

原型页面 ID 包括 projects、creation、story、script、storyboard、finishing、assets、tasks、settings、components、states；实际文件与关系始终以 manifest 为准。

维护交互 PRD 时使用可用的 interaction-prd skill；只修改内容文件、原型、标注和 manifest，不重写 `interaction-prd-workspace/runtime/` 阅读器底座。新增页面或跳转同步 manifest；公共组件变化同步 R1/R2；提示词变化同步 R4 的 Markdown/JSON；架构变化同步 R5；图表源文件变化重新生成对应 SVG 并检查。

文档读取按需进行，默认搜索排除 `node_modules/`、`exports/` 和 `reference/history/`。不得读取或输出凭据、`.env` 等密钥内容；生成媒体、凭据和数据库持久数据不应加入版本库。开发方案与完成事实分开记录，文档校验不能代替真实 AI 或成片验收。

## 五、运行与验证入口

在项目根目录执行：

```sh
cd interaction-prd-workspace
npm ci
npm run dev
```

`npm ci` 用于首次安装或锁文件变更后；已有服务运行时不重复启动。PRD 默认入口为 `http://127.0.0.1:4173/`。

文档/manifest 修改后执行 `npm run validate`。工作台交互修改按影响范围执行 `node reference/tests/workbenches-v5.mjs`，并检查相关浏览器页面。这是原型数据回归，不是生产系统测试。

生产工程在根目录执行 `make bootstrap`、`make dev`；应用 `http://127.0.0.1:5180/`，API `http://127.0.0.1:8010/docs`，专用 PostgreSQL 55432、Redis 56379。`make test` 使用隔离测试库与真实 Redis Worker；`make check` 静态检查；`make contract` 更新前后端契约。备份前停写，执行 `make backup`、`make restore-check`。目录与环境要求见 [工程 README](README.md)，M0 完成事实和边界见 [M0 验收记录](docs/engineering/m0-verification.md)。Compose 配置已提供，本机未安装 Docker，容器启动不计入已验证事实。
