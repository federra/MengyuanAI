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
