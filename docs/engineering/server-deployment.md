# 单人服务器部署检查点

用户于2026-09-09明确授权当前版本提交、合并main、推送GitHub并部署，覆盖此前不合并/不推送的限制；授权迁移全部已有项目和媒体，模型凭据不迁移。M2三镜真实链通过不等于所有M2验收关闭，不进入M3。

服务器采用独立运行目录与服务账户，应用端口仅绑定环回地址，Nginx HTTPS入口配置单人HTTP Basic认证；这不是多用户账号体系。已有网站和数据库独立保留。无域名时申请IP证书并配置自动续期，未完成公网验证前不标部署成功。

新增SHORTFILM_PUBLIC_ORIGIN明确受信HTTPS来源；公网模式所有写接口拒绝其他Origin和cross-site请求，反向代理入口认证覆盖页面/API/媒体，后端不得直接公开。模型密钥在部署后的系统设置页面重新录入，凭据目录与媒体备份分离。

提交前147项后端回归、29项浏览器回归、契约/构建和静态检查通过，独立M2代码复审无阻断。Dockerfile补齐FFmpeg依赖；本次服务器采用原生服务，不能计作容器验证。

迁移前通过现有取消API结束旧写实项目两个从未提交供应商的waiting_dependency任务，保留取消历史。停写备份20260909T025013260003Z完成，隔离恢复核对10项目/29文件通过；包括真实三镜及尾帧，不包含模型凭据。部署结果与公网访问方式完成后补录。

## 2026-09-09 部署结果

工程提交 `43af009` 已从 `codex/m2-media-chain` 快进合并到 main 并推送 `federra/MengyuanAI`。服务器运行该提交，后续本记录的文档提交不改变部署代码；M1 回退标签 `m1-baseline-20260908` 保留。

公网入口为 `https://121.199.40.214/`，使用独立单人访问账号。随机密码仅保存在本机忽略目录的私有交付文件，服务器仅保存 bcrypt 摘要；不使用 SSH root 密码，也不在仓库保存密码。模型和素材 AK/SK 凭据未迁移，需在公网应用设置页面重新录入。

服务器使用 Ubuntu 24.04、Python 3.12 和独立 PostgreSQL 18/mengyuan（55432），不替换已有 PostgreSQL 16。目录为 `/opt/mengyuanai/releases/43af009`，`/opt/mengyuanai/current` 指向该版本；持久媒体 `/var/lib/mengyuan/media`，凭据 `/var/lib/mengyuan/credentials/vault`，运行配置 `/etc/mengyuanai/runtime.env`。API 18010、Redis 56379 和新数据库仅监听环回地址；系统账户 shortfilm 运行服务。

systemd 服务为 `mengyuan-api`、`mengyuan-worker-ai`、`mengyuan-worker-media`、`mengyuan-dispatcher`、`mengyuan-redis`，均已启动并开机启用。Nginx 配置 `/etc/nginx/sites-available/mengyuanai` 覆盖 HTTPS 页面、API 和媒体的登录认证。原有域名站点及 HTTP IP 服务保留，访问新应用必须使用 HTTPS。

Let's Encrypt IP 证书路径 `/etc/letsencrypt/live/mengyuan-ip/`，本次证书到期日 2026-09-15；独立 Certbot 5.8 安装在 `/opt/mengyuan-tools`。`mengyuan-cert-renew.timer` 每天两次检查续期，成功续期后 reload nginx。实际 HTTPS 校验证书成功（verify=0），Certbot `renew --cert-name mengyuan-ip --dry-run --no-random-sleep-on-renew` 模拟续期通过。

公网验证：未认证访问首页、项目 API 和健康接口均返回 401；认证后健康检查 200、数据库 ready，项目总数 10；备份 manifest 的全部 29 文件通过 HTTPS 下载并逐一 SHA-256 一致。错误项目下访问其他项目视频返回 404；外域写请求 403，受信来源无效输入返回 422。生文/生图/生视频/生音频的凭据状态均为 configured=false。没有发起模型调用。

浏览器首次与大文件核对同时运行时媒体等待达到 30 秒超时；独立复查三视频和两音频均加载且无媒体错误，刷新后重开项目保留分镜与媒体。UI 仍沿用现有实现，不能据此标记最终视觉验收通过。

迁移包与备份仅 root 可读，保留于 `/opt/mengyuanai/transfer` 和 `/opt/mengyuanai/transfer.tar.gz`，数据库恢复前本地已停写并通过隔离恢复演练。备份完成后本地应用恢复运行；本机与服务器是独立数据副本，后续操作不会自动互相同步。尚未配置周期性服务器数据备份。

运维检查可运行 `systemctl status mengyuan-api mengyuan-worker-ai mengyuan-worker-media mengyuan-dispatcher mengyuan-redis`；证书检查 `systemctl list-timers mengyuan-cert-renew.timer`。部署回退应先停应用写入并备份当前数据库和媒体，不能仅切换代码来撤销数据库变化。

最终独立浏览器播放检查通过：三段真实视频与两段配音均成功启动、播放时间前进，刷新重开项目后媒体仍保留。初版固定 500ms 的播放断言受网络缓冲影响失败，改用最长 30 秒内实际播放时间前进的条件后通过；此调整仅影响本地核验脚本，没有修改播放器实现。证据保存在本机忽略目录 `.local/deployment/public-verification.json`、`browser-verification.log` 和 `public-app.png`。

## 2026-09-11 当前集成版本覆盖发布

用户本轮明确授权提交、合并main、推送及覆盖原服务器应用。代码提交`e25c96224575dbea73459db500bc0ca6fc59aade`已从codex/v12-v13-ui-alignment快进合并main并推送GitHub；测试代码树与合并后完全相同。原主工作区独立PRD草稿保留。本轮部署M3及后续交互增量，不覆盖服务器数据库为本地数据。

发布前242后端、110页面全量回归通过，OpenAPI一致、构建、静态检查、PRD校验通过。旧测试的确认弹窗及纯文本提示词入口已按已批准的新交互同步，原草稿、来源、幂等恢复断言保留。

服务器新release为`/opt/mengyuanai/releases/e25c962`，`/opt/mengyuanai/current`已切换；原`43af009`目录保留。Python依赖按锁文件安装；新增fonts-noto-cjk，并在shortfilm服务账户下验证中文字体可读取。未更换HTTPS地址、认证账号、密码、证书配置或模型凭据；内部API18010/PG55432/Redis56379继续仅监听环回地址，证书续期timer有效。

成功备份为`/opt/mengyuanai/backups/20260911T065907`，含database.dump、media.tar.gz、private-config.tar.gz及report.json，目录仅root可读。从该备份恢复到隔离库后演练M3导出、分镜JSON、实体工作流迁移，旧表旧列全部行摘要不变；媒体归档解包后29文件哈希一致。正式升级至`20260910_entity_workflow`后再次核对旧行摘要不变，仅另外补入3份风格模板。服务器原11项目、29文件、57成功/2未知/6失败/2取消任务保留，无供应商调用。本地新增项目、素材与数据库未传到服务器。

首次两次尝试分别因迁移命令继承root证书目录及缺少服务认证环境失败，均在开放请求前恢复旧数据库和旧release；对应备份065502、065639保留。最终采用PostgreSQL本机管理通道并SET ROLE至原shortfilm数据库角色，避免读取或更改应用密码。迁移期间临时维护入口阻止新请求；成功后撤销，Nginx原认证配置恢复。运维脚本保留于服务器`/opt/mengyuanai/incoming/upgrade-server.py`，不含密码。

公网验证通过：真实HTTPS证书验证、未认证首页/项目API/健康401；原nathan账号认证后页面、项目API、健康200；11项目及三份风格模板可见，分镜工作台可打开；全部29媒体通过HTTPS下载并逐一SHA-256匹配。浏览器无页面异常，验证无API写入。证据为本机忽略目录`.local/deployment/public-release.json`、`public-release.png`、`public-board.png`、`server-upgrade-report.json`。本轮未调用付费模型或制作新的真实MP4，发布成功不替代最终UI与用户完整主链验收。

回退须重新停写并备份当时新增数据；切回43af009同时恢复对应旧schema备份，不能仅切换代码或在线强行降级。私有配置备份仅用于故障恢复，不写入Git。本条后续文档提交不改变已部署代码e25c962。
