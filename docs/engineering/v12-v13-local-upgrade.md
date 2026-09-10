# V12/V13 本地升级与回退方案

2026-09-10。执行状态：**用户明确回复“授权”后，本地停写、备份恢复、迁移及服务切换已完成**。以下保留执行方案，末尾记录实际结果。

## 范围与检查点

- 原运行目录：`/Users/nathan/Codex_Projects/MengyuanAI`，分支`codex/m3-real-export`，原代码基线`cad6c2d`。该目录最新未提交PRD与ZIP不改动。
- 新工程：`/Users/nathan/Codex_Projects/MengyuanAI/.local/ui-v12-v13`，分支`codex/v12-v13-ui-alignment`。使用当前已审查的本地提交，提交号补入验收记录。
- 仅切换本地5180前端/8010 API及现有Worker/dispatcher；PostgreSQL55432、Redis56379和原媒体、凭据目录保留。无公网部署、Git合并或推送，无新供应商调用。
- 新增迁移`20260910_board_import`，前置`20260909_m3_exports`。创建预检、幂等提交、待制作图片描述3表；取消`shot_reference_versions.ref_id`只能指向文件的外键，改由服务端严格验证项目/镜头/描述身份；真实`file_id`外键保持。原业务表不改行。
- V12故事数量与单镜覆盖复用追加式配置绑定，不做原项目内容批量重写。旧模板/任务/媒体快照保持读取兼容。

## 已完成的恢复准备

使用M3备份`.local/backups/20260909T055254635250Z`在一次性`shortfilm_restore_v13_*`库执行真实恢复与升级。34张既有业务表逐表行数及内容SHA256未变，36个媒体文件哈希一致；新版API读取所有项目的分镜、剪辑和待制作描述成功。未复制/读取凭据，未启动Worker或模型调用；演练库已删除。证据`evidence/v12-v13-restore.json`，脚本`scripts/v12-v13-restore-rehearsal.py`。

该旧备份证明恢复路径，不替代停写后的最新备份。新备份必须在授权后、迁移前制作。

## 授权后执行顺序

1. 只读检查生产任务状态和本项目进程归属；有活动或受理不明任务时保留状态，先报告具体任务，不强制取消。记录现有项目/内容/配置/任务/媒体计数及哈希。
2. 停止本项目`make dev`的API、两个Worker、dispatcher和Vite；不停止数据库/Redis，不影响其他项目。在原运行目录执行`make backup`与`make restore-check`，记录新备份路径、文件数与哈希。
3. 从新工作树对生产库执行唯一增量迁移`alembic ... upgrade head`。不运行bootstrap、seed、不创建演示项目。核对34张既有表的行与媒体哈希保持。
4. 从新工作树启动本地服务，显式设置`PYTHONPATH`到新源码，`SHORTFILM_STORAGE_ROOT`到原`.local/media`，`SHORTFILM_CREDENTIAL_ROOT`到原`.local/credentials`，保留本次`SHORTFILM_TEXT_MAX_TOKENS=4096`。避免共享venv的旧editable路径误加载旧代码。仅正常应用内部沿用加密凭据，不输出或复制密钥。
5. 只读HTTP和浏览器检查：5180新版控件、API导入路由、既有项目/历史、M3既有MP4可读取；不点击生成、自动质检或导入提交，不新增费用。提供用户试用入口。

## 回退

- 迁移失败时停止新版启动，核对事务及schema；保留失败证据。确认未导入新数据时可回到M3 schema并启动原代码，必要时使用最新停写备份。
- **已有成功导入后不允许直接降级**：旧代码不能表达待制作引用。迁移脚本明确拒绝这种降级。必须先保存当前新数据备份，再经用户确认恢复升级前数据库/媒体备份；说明恢复时间点后新增数据的影响，不能擅自删除。
- 凭据目录不属于普通媒体备份，不覆盖、删除或输出。原目录与原Git状态完整保留，切换不需要合并main。


## 实际执行结果（2026-09-10）

- 从审查检查点19b18b3切换本地服务。最新备份：原目录.local/backups/20260910T035102660239Z；恢复验证11项目、36文件通过。对该最新备份另做V13隔离升级演练，通过后才迁移本地正式库。
- schema从20260909_m3_exports升级至20260910_board_import。34张既有业务表逐行内容摘要及36个媒体哈希与最新备份一致；证据见evidence/v12-v13-local-upgrade.json。两条历史unknown配音任务已派发但待核实，原样保留，未重发或取消。
- 仅停止旧API、两个Worker、dispatcher与Vite；数据库/Redis及PRD服务保持。新版从本工作树启动，postgres/redis/bin符号链接复用原依赖；媒体及加密凭据仍使用原路径。
- 5180与8010正常；11项目的33次分镜/剪辑/导入描述读取通过。旧M3真实MP4下载HTTP200，5444867字节，SHA256为74f339448e97dfedf532c42bd51831230b50d72cc011c3e1ad6b86840e6a8267，与原成片一致。
- 真实浏览器四主题项目卡均三列、创意框115px；live-smoke.json与live-*.png记录真实页面，拦截写请求且实际写请求0。无新增供应商调用，无合并、推送或公网部署。原工作区未提交PRD与ZIP保持；工程检查不代表用户视觉接受。

### 后续本地启动

当前服务已运行，无需重复启动。将来正常停止应用进程后，从新工作树使用下面命令；避免原目录旧代码重新接管。

```sh
cd /Users/nathan/Codex_Projects/MengyuanAI/.local/ui-v12-v13
PYTHONPATH="$PWD/services/backend/src" SHORTFILM_STORAGE_ROOT=/Users/nathan/Codex_Projects/MengyuanAI/.local/media SHORTFILM_CREDENTIAL_ROOT=/Users/nathan/Codex_Projects/MengyuanAI/.local/credentials SHORTFILM_TEXT_MAX_TOKENS=4096 make dev
```

备份仍从原目录执行既有make backup/make restore-check，先停写。未来迁移或恢复覆盖按当时具体方案执行。
