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
| 模型文字树、四类默认/环节覆盖、场景提示词、风格和视频默认配置 | [05 模型与提示词配置](interaction-prd-workspace/prd/05-ai-configuration.md) |
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
| V11 无衬线排版与四主题 | [V11 字体验收](interaction-prd-workspace/reference/verification-v11-typography-themes.md)；共用字号体系、曜夜鎏金；生产已做阶段性同步，UI 视觉验收仍未通过 |
| V10 设置配置与模型文字树 | [V10变更与验收](interaction-prd-workspace/reference/change-v10-settings.md)；设置直达、音频并入模型、类别默认/覆盖、场景模板与紧凑文字树 |
| V9 具名方法与资源库 | [V9变更与验收](interaction-prd-workspace/reference/change-v9-method-library.md)；Skill库/提示词库、具名方法、纵向对齐、创意助手无方法选择 |
| V8 工作流变更与工程增量 | [变更交接](interaction-prd-workspace/reference/change-v8-workflow.md)、[验收记录](interaction-prd-workspace/reference/verification-v8-workflow.md)；原型调整不代表生产工程已实现 |
| 已做过的验证及其边界 | [技术规划验收](interaction-prd-workspace/reference/verification-v7-technical-plan.md)、[主题验收](interaction-prd-workspace/reference/verification-v6-themes.md)、[工作台验收](interaction-prd-workspace/reference/verification-v5.md)；其他记录按 `reference/verification-*.md` 检索 |

历史输入见 [输入材料](interaction-prd-workspace/shaping/00-intake.md)，旧版文件集中在 `interaction-prd-workspace/reference/history/`，仅在追溯明确历史决策时读取。隐藏的 [00 板块计划](interaction-prd-workspace/prd/00-plan.md) 是过程产物；[R3 参考视频再创作](interaction-prd-workspace/reference/deferred-video-remix.md) 是延期方向，不能自动纳入当前开发范围。

## 三、当前必须记住的决策

- 核心目标是用流畅、简洁的完整流程提升短片生产效率与成片质量。质检是辅助机制，不把外部复制粘贴作为首要产品问题。
- 系统从零建设，数据库采用 PostgreSQL；首先在本地跑通“一句话 → 故事 → 剧本 → 分镜 → 参考图/配音 → 视频 → 真实 MP4”。已有故事 TXT 入口保留在产品范围中，随后复用主链。工程要兼顾后续部署，不能以浏览器缓存充当正式数据存储。
- 左侧五模块为项目、创作、资产、任务记录、系统设置；创作顶部五阶段为创意、故事、剧本、分镜、导出。项目创建选择画幅比例、分辨率，不设固定时长；规格继承至视频生成与导出，可在生成设置统一修改。故事、剧本、分镜的 AI 质检均为建议，用户可保留当前版本继续，不以质检通过作为门槛。
- AI 建议由用户采用后才更新内容；保存源版本、稳定镜头/台词/图片 ID、配置快照和历史结果。上游修改明确标记下游过期。顺序视频依赖前镜真实视频末帧，失败时不跳镜。
- 仓库保留独立交互 PRD 与 Demo，并已新增 M0 工程底座：React/TypeScript 前端、FastAPI、PostgreSQL、文件存储与持久任务。真实 AI 与编码尚待 M1–M3 实施。PRD Demo 的 UI 有浅色、深色、晴空蓝、曜夜鎏金四主题，UI 主题与成片视觉风格互不影响。方法按名称选择并关联Skill或提示词模板；资产中管理Skill库与提示词库，提示词库与设置共用同一份资源。创意助手不提供方法选择，其他助手从故事环节起提供。

- 设置直接打开模型/提示词/风格三 Tab 面板；音频归入生音频，不单列模块。模型左侧采用“>”展开收起的紧凑无边框文字树，类别默认可被环节覆盖；此树形样式仅用于模型 Tab，提示词和风格模板保持原样。提示词按场景绑定具名模板，与资产库同源。正式细则见 PRD 05 与 R1/R2，原型变化不代表生产工程已实现。

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

文档/manifest 修改后执行 `npm run validate`。工作台交互修改按影响范围执行 `node reference/tests/workbenches-v5.mjs`，并检查相关浏览器页面。设置配置变更另执行 `node reference/tests/workbenches-v10.mjs`；浏览器脚本为 `reference/tests/workbenches-v10-browser.mjs`（按本机环境设置 `PLAYWRIGHT_MODULE`）。文字树的行高、展开/收起、键盘焦点、多类别选择与其他 Tab 不受影响，按 PRD 05 验收点检查。以上属于原型回归，不是生产系统测试。

生产工程在根目录执行 `make bootstrap`、`make dev`；应用 `http://127.0.0.1:5180/`，API `http://127.0.0.1:8010/docs`，专用 PostgreSQL 55432、Redis 56379。`make test` 使用隔离测试库与真实 Redis Worker；`make check` 静态检查；`make contract` 更新前后端契约。备份前停写，执行 `make backup`、`make restore-check`。目录与环境要求见 [工程 README](README.md)，M0 完成事实和边界见 [M0 验收记录](docs/engineering/m0-verification.md)。Compose 配置已提供，本机未安装 Docker，容器启动不计入已验证事实。


## M1 故事工程补充（2026-09-08）

M0 已保存 Git 标签 `m0-baseline-20260908`（`cf2d2c6`），审查记录见 `docs/engineering/m0-baseline-review.md`。故事工作台、追加版本、选择、导演建议采用及 DeepSeek 适配器已新增；用户确认采用 `DEEPSEEK_API_KEY`，尚未注入，因此真实文本模型闭环验收仍待完成，不得写成整个 M1 已通过。`make test-ui` 使用独立5181页面及 API 替身；`make dev-deepseek` 允许终端隐藏输入密钥，仅传给当前进程。具体边界见 `docs/engineering/m1-story-verification.md`。PRD Demo 与生产工程继续独立。


## 最新 M0/M1 工程状态（2026-09-08）

按更新后的 V8/V9/V10 增量接入配置资源及完整文本内容链：创意、故事、剧本、分镜、建议质检/修复、确认和版本保存；仅必要扩展现有工程。后端49项、浏览器19项、契约/构建/静态检查与真实HTTP/PG/Redis/Worker的文本替身链通过；开发任务及最终两项恢复修复均独立复审通过。原项目库已升级且2项目/1媒体及既有内容/任务保留，升级前后隔离恢复演练通过。最新事实见 `docs/engineering/m0-m1-verification.md`，原故事记录是历史子阶段，不再代表全部当前能力。用户明确密钥尚未注入、本轮先完成工程与替身验收；真实DeepSeek、M2/M3媒体成片及后续TXT入口仍未计入已验收能力。

## 页面凭据配置补充（2026-09-08）

系统设置 → 模型 → 生文现已支持密码框录入、服务端认证加密保存及真实连接测试；API/Worker共享私有凭据目录，保存后无需重启。工程c6f5020通过63后端/21浏览器回归及独立审查；真实M1仍等待页面保存密钥后执行，不以连接测试代替完整内容链验收。操作与安全边界见 `docs/engineering/page-credentials-verification.md` 和README。

## M1 真实验收完成补充（2026-09-08）

用户已在页面保存DeepSeek凭据，真实M1至确认分镜通过；生产项目「M1 真实验收 · DeepSeek」保留故事3版、剧本4版、分镜2版（11镜），两次非法分镜输出失败历史保留。必要纠错诊断修复9437b3e经64后端回归及独立复审，21页面回归通过；备份及隔离内容恢复核对通过。最新事实见 `docs/engineering/m1-real-verification.md`，上文等待密钥为历史状态。真实图片/配音/视频、MP4及容器运行仍未计入通过。


## 当前开发顺序与 UI 验收状态

M1 真实文本链已通过工程验收；生产 UI 在 f8955c4 完成阶段性原型对齐，但用户试用后明确仍有诸多差距，视觉验收未通过。按用户最新决定，先推进 M2，再完成 M3 真实 MP4 闭环，随后集中完成最终 UI 对齐；不能将此前截图复核或测试通过写成用户已接受 UI。后续开发继续遵循最新 PRD 和公共组件，影响操作的遮挡、状态不清与草稿丢失须当轮修复，其他视觉差距记录后统一收尾。详见 `docs/engineering/ui-prd-alignment.md`。


## M2 分支实施状态（2026-09-09）

`codex/m2-media-chain` 已新增元素/参考图版本、Seedream/MiniMax/Seedance适配、逐台词配音和视频尾帧顺序任务链，尚未完成真实供应商验收。用户接受供应商组合与多参考尾帧语义，提供视频模型 `doubao-seedance-2-0-mini-260615`。生产服务未重启、数据库未迁移：自动审批拒绝停写及生产迁移，需明确批准；批准迁移不代表批准付费调用。最新工程证据与边界见 `docs/engineering/m2-verification.md`。不得将分支实现或替身回归写成M2已通过。


### M2 升级及测试隔离更正

用户随后明确批准停写/备份/迁移/重启，已完成并核对既有行及媒体哈希不变，生产已为M2 schema。三类媒体模型配置已保存，密钥和付费验收待用户。早期子代理3次直接pytest误连默认库，留下3个测试项目和1张测试图片，无内容或生成任务；已披露并保留，不能算真实媒体。tests/conftest.py现强制 shortfilm_test_* 库和系统临时媒体子目录，缺失配置在测试导入前拒绝；统一执行make test。不得再将此前“未写生产”的错误表述作为事实。

## M2 真实媒体阶段更新（2026-09-09）

专用三镜项目已有8张真实Seedream图（7张确认）及4段真实MiniMax MP3；配音6次请求含2次失败及用户批准重试，HTTP重载/跨项目隔离/浏览器解码及逐句上游失效通过。MiniMax使用官方`https://api.minimax.cn/v1`；此前等待充值已是历史。视频首镜两次同步拒绝、无任务ID，后续两镜等待依赖，真实三镜尾帧链尚未验收，M2未完成。最新事实与剩余额度见`docs/engineering/m2-real-verification.md`；不进入M3，不自动推送/合并。

## M2 素材凭据入口补充

生视频配置新增折叠“方舟素材上传与审核配置”，AK/SK通过密码框原子加密保存，桶预填mengyuanaibucket、地域cn-beijing、资源项目mengyuanai。连接未验证，自动TOS上传/素材入库尚未完成；不得将凭据保存当作真实视频链通过。详见docs/engineering/m2-ark-assets-integration.md。


最新检查点：非真人7图/2句配音/3段720P视频全部真实成功，实际总12.125秒；按usage和用户确认折扣估算4.16438元，非实际账单核对。真实尾帧依赖、同ID重启恢复、保存重载、失效传播和隔离通过；中镜真实故障恢复、最终备份及分支复审仍待收尾，M2未整体关闭。后续测试继续非真人卡通、整轮≤5元、不超过两句；详见docs/engineering/m2-real-verification.md。不进入M3、不合并或推送。

## M2 真实验收完成补充（2026-09-09）

M2图像/逐台词TTS/真实三镜视频和前镜尾帧链已通过；新增中镜本地尾帧故障注入验证后镜等待、页面重试复用原视频且第一镜不重做。保存重载、受理后重启、过期传播、项目隔离、最新10项目35文件备份恢复与独立最终复核通过，R5 M2退出条件完成。最新事实见 `docs/engineering/m2-final-verification.md`，历史待验收描述不再代表当前状态。验证限已选模型与非真人卡通路线；账单未核对，M3真实成片及最终UI验收仍未完成。本轮新结果仅保存在本地，公网未同步；当前分支codex/m2-media-chain，不自动进入M3或推送/合并/部署。


## M3 本地成片检查点（2026-09-09）

实际M2完整基线9c077d4已在main提交；本轮新建本地回退标签m2-baseline-20260909，再创建codex/m3-real-export。已新增剪辑版本、基础排序/时长/音轨/字幕、真实MP4预览下载和持久导出恢复；复用卡通三镜两句真实素材生成12秒720P成片，新增供应商费用0元。159后端、32页面回归及独立复审通过，最终10项目36文件停写备份/隔离恢复通过，M2既有行与文件保持。最新事实见docs/engineering/m3-verification.md。

工程与真实合成链通过不等于M3整体关闭：用户从一句话独立操作到下载仍待试用，步骤和未批准≤5元用量方案见docs/engineering/m3-user-acceptance.md。页面没有自动账单硬限额，新增付费须先核价和用户确认，三镜/最多两句/非真人继续适用。最终UI和容器未验收；本轮仅本地可试用，不合并main、推送、部署或进入M4。

2026-09-09后续：用户已确认5元三镜两句独立试用方案，不再重复询问预算批准。当前仅完成环境准备（本次进程文本输出上限4096）与空台账，尚无新项目或付费调用；下一步由用户新建并保存创意后绑定台账、核输入用量，再亲自生成。详见m3-user-acceptance.md启动准备；M3仍待用户验收。
