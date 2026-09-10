# V12/V13 生产交互与四主题增量实施计划

> 执行：使用writing-plans、test-driven-development与dispatching-parallel-agents；按独立领域实现后集成审查，用户已授权直接推进，不重复请求设计审批。

目标：保留现有M0–M3能力，把最新PRD的V12/V13及U01–U07适用条件落实到真实前后端；U08留待用户明确接受。
架构：React/TypeScript、FastAPI、PostgreSQL现有版本/绑定资源、Job/Outbox/Worker和媒体存储增量扩展；不重建系统，不调用付费模型。
基准：cad6c2d + 原工作区最新未提交PRD。基准文件哈希见.local/ui-v12-v13/baseline.json，原PRD文件/ZIP保留未动。开发分支codex/v12-v13-ui-alignment，隔离工作树.local/ui-v12-v13，避免生产Vite热更新。生产升级前另请求具体停写/迁移授权。

## 差异清单

| 领域 | 已实现 | 需修改 | 缺失 |
|---|---|---|---|
| 项目/公共布局 | 五模块、五阶段、四主题、项目隔离 | 创建上移、三列、吸顶、字体/尺寸/加载态 | 四主题九页U证据 |
| 创意/故事 | 内容版本、候选历史、幂等、具名方法、真实文本适配 | 115px输入、横排、移除创意助手、再生成数量 | storyCount1～3持久化/冻结/严格输出数量 |
| 分镜/TTS | 稳定ID、逐句真实配音/失败恢复 | 七列改六列，TTS进入台词28px工具行 | 单句独立工具展示及绑定折叠区 |
| 视频 | 单镜/顺序尾帧链、素材确认、来源过期、持久任务 | 风格正文与逐句台词编译/冻结 | 单镜覆盖、独立多镜批次/限流/跳过原因 |
| JSON导入 | 内部BoardBody v2严格校验、整表历史版本 | 前端换表与迟到响应保护 | 用户v1适配、预检/事务提交/映射/幂等/描述元素 |
| 成片 | 真实MP4、混音字幕、幂等恢复/备份 | 新导入和单镜覆盖的来源失效连带 | 新增行为与既有成片回归证据 |

## 全局约束与接口协调

- PRD01–10、R1/R2/R4/R5、U01–U08及contracts/storyboard-import.*为规格；旧验收不改写。
- 仅通过`PYTHONPATH="$PWD/services/backend/src" make test`运行后端隔离回归；共享venv必须显式指向本工作树源码，不直接pytest。前端测试独立端口，生产8010/5180只读。
- 不读取.env/凭据；不供应商调用、不生产写入、不自动合并/推送/部署。生产停写/迁移前先提供增量SQL、核对、备份恢复和回退方案。
- 响应丢失复用原幂等键、源冲突保留草稿、ID不能依赖行号；新导入旧媒体保留历史，不能伪装已生成。
- 后端媒体与导入任务在独立文件中实现，路由主注册与生成契约由主代理最后统一集成。新增迁移序列需协调，单镜配置优先复用版本化ConfigBinding。

## Task 1：V12后端数量契约

文件：creation/schemas.py、router.py、execution.py、snapshots.py及需要的配置服务；tests/test_story_count.py。
接口：IdeaSave和BatchCreate增加可选story_count（缺省3/沿用已保存值），ContentOut.body暴露已存数量；项目创作配置以现有JSON持久化，输出长度根据任务快照验证。新任务数量进入幂等指纹、模板变量、应用约束；旧任务无数量按3。
- [x] 先测试1/2/3候选、0/4/小数/null拒绝、跨项目、冻结数量与字数要求、同键异数量冲突、错误输出不落库。例如`assert len(client.get(base+'/stories').json()['items']) == requested_count`，并检查真实Job.snapshot。
- [x] 实现最小字段/入队/worker校验与兼容，保留3项分页及批次内稳定顺序；已有模板不破坏用户编辑，程序附加数量约束。
- [x] 隔离回归，报告接口和审查记录。

## Task 2：V13视频领域

文件：media/sources.py、commands.py、execution.py、schemas.py及新shot_settings/batches文件；tests/test_media_v13.py。
接口：GET/PUT项目下单镜配置（board_version_id、revision、overrides）；批量独立受理返回每镜job/跳过原因和batch_id。实现者尽早固定精确路由/结构。模型配置引用沿用已有路由资源，不能虚构模型库；导入generation通过同一配置服务保存。
- [x] 先写请求传输替身断言：最终prompt包含风格正文、lineId/正文、图片序列；配置变化只影响本镜及实际尾帧依赖，旧快照保持。
- [x] 持久化单镜覆盖并解析单镜→项目→默认；独立多镜筛选尾帧依赖/缺素材/已有有效结果，每镜任务幂等。复用持久Worker并发额度及暂停/恢复；一镜失败不取消其他项。
- [x] 隔离测试受理数/跳过原因、供应商提交并发峰值、有受理ID不重发、失败单项重试及M2顺序回归。

## Task 3：事务性JSON整表导入

文件：新增creation/board_import*.py、独立迁移（若需）、tests/test_board_import.py。注册路由由主代理处理。
接口：POST /projects/{pid}/storyboard/import/preview 和 /commit，模板/schema GET；严格原始JSON校验（重复键/NaN/深度/大小/未知字段），preview绑定当前剧本/分镜版本及内容hash。
- [x] 测试合法3镜替换7镜、返回完整表与新ID映射、重载一致；失败/409回滚、同键不重复版、跨项目/错误引用、导入后迟到旧任务只在旧历史。
- [x] 单事务锁项目/当前内容，建立描述元素/参考、整表新版与配置覆盖、切当前指针、清确认、使成片过期。模板v1不能直接作为BoardBody v2。按契约同事务outbox安排建议质检，失败不撤销导入；本轮只在隔离测试中以供应商传输替身验证，不向生产提交导入或付费任务。真实页面明确自动质检会用模型。
- [x] 成功返回完整ContentOut/映射/统计；预检变化须重新检，同键丢响应可查询；实施失败注入验证事务回滚。

## Task 4：生产UI及四主题

文件：main.tsx、StoryWorkbench.tsx、StageWorkbench.tsx、MediaWorkbench.tsx、style.css、新导入/单镜配置组件；apps/web/tests。
- [x] 对照manifest确定项目/创意/分镜页，测量原型并截图基线。项目上方创建+3列、115px创意、方法/数量/按钮横排、去助手、流程sticky68px。
- [x] 连接真实数量API；六列表和逐句TTS工具、完整绑定信息、单镜规格标签/弹窗、独立批次结果和JSON预检/提交弹窗。导入成功替换整个编辑state和草稿键，失败保留旧表；防迟到响应。
- [x] 四主题九页及弹窗共同检查字体/44px控件/对齐≤2px/对比度/焦点、三视口和200%缩放；工程状态测试使用隔离替身，真实API保存/重载使用隔离库。

## Task 5：集成、升级准备与交付

- [x] 更新OpenAPI/TS契约，make check、make test、make test-ui及PRD validate，复用本地媒体编码夹具不新增供应商调用。
- [x] 独立最终代码审查与修复；U01–U07记录证据及问题编号，U08待用户。原型截图/生产截图同视口/同数据，差异必须解释。
- [x] 提供生产停写/迁移具体方案及备份恢复准备，得到执行授权后才升级；既有项目/媒体/任务/凭据保持。无迁移也需服务切换授权，不在原运行目录提前热更新。
- [x] 工程完成记录写docs/engineering/v12-v13-verification.md，提供本地入口与精简用户步骤。不把自动测试或替身结果写为视觉接受/真实新增供应商验收。

实施状态：Task1–4工程验证已完成；Task5本地生产升级已获授权并执行，用户验收尚未完成。U项范围及限制以v12-v13-verification.md为准，不把此任务清单当作U08通过。
