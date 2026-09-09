# M2 方舟可信素材接入增量（部分实施，真实入库待验收）

## 已确认事实与范围

用户确认具备私域虚拟人像权限，授权继续核对接入；并未授权新增订阅/购买权益包。2026-09-09 首镜真实响应为 `InputImageSensitiveContentDetected.PrivacyInformation`，说明普通参考图片触发输入隐私审核。已有四段真实配音和八张真实图片保留，M2 未通过视频验收。

当前 `providers.py` 只支持普通图片 data URI；不能仅允许 asset:// 字符串就宣称已支持可信素材。必须先完成入库审核、真实文件对应关系、资源项目匹配、快照与恢复。实现仍属于 M2 必要媒体链修复，不扩展为通用云资产管理，不进入 M3。

## 官方契约（2026-09-09 核对）

- [私域虚拟人像指南](https://www.volcengine.com/docs/82379/2333565)：先 CreateAssetGroup，再逐文件 CreateAsset，GetAsset 轮询至 Active。非人像素材无需入库；同一形象的未入库图片也不能用已入库另一张图的 ID 冒充。素材项目与视频 API Key 的 ProjectName 必须一致。
- [CreateAssetGroup](https://www.volcengine.com/docs/82379/2318270)：POST `https://ark.cn-beijing.volcengineapi.com/?Action=CreateAssetGroup&Version=2024-01-01`；Name 必填，Description 可选，GroupType=AIGC，ProjectName 默认 default。首次使用相关承诺须由用户在官方控制台完成，不能由代理替签。
- [CreateAsset](https://www.volcengine.com/docs/82379/2318271)：同一域名、Action=CreateAsset；URL、GroupId、AssetType=Image、Name、ProjectName。正式动态页面示例为可访问 HTTPS 图片 URL，未取得支持 data URI 的官方证据，因此不按支持 Base64 实施。响应 `ResponseMetadata` 与 `Result.Id`，ID 仅表示提交，不表示审核成功。
- [GetAsset](https://www.volcengine.com/docs/82379/2318274)：Id、ProjectName；Status=Processing/Active/Failed，HTTP200仍可能表示业务失败，应读 Error.Code；URL 返回有效期12小时，不能长期当作源文件地址。
- 素材 API 仅支持 AK/SK 签名，与推理 Bearer API Key 独立。服务 ark、地域 cn-beijing、版本2024-01-01，签名请求不得输出 Authorization、AK/SK 或签名URL。
- 视频继续使用原推理 API Key，把对应 image_url.url 替换为 `asset://<已审核AssetID>`，role 保持 reference_image；普通场景/道具仍复用现有图引用。

## 工程增量与依赖

1. 复用页面加密凭据库，增加素材服务 AK/SK 安全配置、TOS地域/桶及火山 ProjectName；只返回 configured/revision 元数据。用户已提供桶和资源项目并在页面保存AK/SK；不在聊天收密钥，不自动开通收费资源。
2. 私有TOS上传使用短时可读签名URL供方舟抓取，禁止将本地媒体目录公开或使用第三方临时图床。云端上传与本地文件按SHA256核对；桶/地域/签名权限和SDK契约需另行核对。
3. 保存本地项目、文件ID/SHA256、供应商账号/资源项目、素材组/AssetID、状态、配置版本。只允许当前项目对应文件绑定，Active才能用于推理；审核失败保留错误码和历史。
4. 素材上传/审核复用持久任务与未知受理保护；创建请求发出前记录意图，取得AssetID后仅查询恢复，不能因重启重复创建。配置变更、源文件替换与素材失效应重新核对，不覆盖旧快照。
5. 两张角色参考图、三张含人物站位图都需按真实文件处理；后续含人物的真实视频末帧也必须完成入库并Active后再提交下一镜。不得用角色图替代真实尾帧，不改变此前多图连续性边界。
6. UI延用元素/图片/任务公共组件，显示“待入库、审核中、可用、审核失败、待核实”，提供来源与失败原因；不得把审核中显示为可生成。

## 验收与费用边界

工程测试覆盖签名正确性、错误封装、HTTP200业务失败、跨项目/账号隔离、配置快照、未知创建不重发、审核恢复、末帧审核等待及下游失效。既有M1与媒体回归继续通过。

真实验收需先证明素材入库/查询，再恢复原三镜链，完成真实末帧连续依赖、保存重载和中断恢复。原视频5次/25秒额度已计满（3次首镜请求、2个待发送任务），当前总预留27.07645元；新的素材服务使用、TOS费用与后续视频调用先形成最小计划及新增用量上限，待用户确认后执行。替身和公开文档不是实际账号可用性或真实三镜通过的证据。

## AK/SK 页面入口完成更新

用户最新配置：桶`mengyuanaibucket`、华北2（北京）`cn-beijing`、火山资源项目`mengyuanai`，覆盖此前桶名mengyuanai。已新增“系统设置→大模型配置→生视频→方舟素材上传与审核配置”：密码框录入AK/SK，与桶/地域/资源项目作为一个载荷原子加密保存，使用现有私有凭据库、版本冲突保护和跨域限制。GET不回传密钥，422不回显输入，敏感响应no-store；浏览器不持久化密钥，保存成功清空输入框。未保存密钥在离开配置页时清除，页面已提示。

这是安全配置入口，不是TOS上传、Assets API或审核链完成；连接状态明确not_tested，没有虚构连接测试按钮。未读取用户密钥，未发起外部调用。129项完整后端回归、契约/构建通过，独立安全复审无阻断。

页面回归29项通过，新增用例验证双密码框、保存后清空及localStorage无密钥；生产重启后配置状态接口HTTP200并返回Cache-Control:no-store。配置入口已可试用，等待用户在页面录入后再核验状态。

## 真实读取权限检查（2026-09-09）

用户页面保存后metadata显示configured=true、revision1，配置为mengyuanaibucket/cn-beijing/mengyuanai。用户批准最多1次TOS桶信息读取和1次素材组查询、总新增上限1元。TOS HeadBucket成功；首个素材查询因工程漏传Filter返回MissingParameter.Filter，未据此认定权限失败。用户另行批准补1次方舟查询（不再请求TOS、总检查费用仍≤1元）；补齐Filter.GroupType=AIGC后ListAssetGroups成功。台账保留`.local/m2-real/access-check-1.json`与`access-check-2.json`，未上传/入库/生成。

采用官方tos2.9.2与volcengine1.0.228，TOS max_retry_count=0/follow_redirect_times=0，Ark固定域名/V4签名/响应大小限制、禁重试；日志不输出签名头或响应正文。新增页面“检查已保存的读取权限”仅表示有限读取权限，不能证明PutObject/CreateAsset/审核和视频生成成功。131项完整后端回归通过；补Filter后的针对性2项检查测试通过，权限工程后续仍需复审及回归。

## 上传传输层与页面检查点（2026-09-09）

已新增独立TOS/Ark传输层：对象SHA256复用核对、禁止覆盖、短时签名GET、CreateAssetGroup/CreateAsset/GetAsset及Processing/Active/Failed状态解析。默认关闭SDK重试与重定向；创建超时或服务端不确定响应保留unknown，不自动重发。签名URL包含AK标识及短时访问签名，是内部敏感值，不得进入公开响应、持久快照或日志。此层尚未接入持久素材绑定和顺序视频工作流，不能宣称自动上传链完成。

本次完整make test为142项通过，契约/前端构建、make check通过。此前29项页面回归通过；配置刷新旧结果问题修复后相关1项页面回归通过，独立复审关闭该问题。传输层复审未发现实现阻断，签名URL测试已改为真实SDK使用假凭据纯本地签名，明确含AK标识、不含SK；修改后11项定向测试及ruff通过（SDK两条弃用警告）。生产服务已平滑重启，新读取检查接口加载成功，配置metadata仍configured=true/revision1，敏感响应no-store；没有重复请求云服务。

真实边界仍为一次成功HeadBucket和一次成功ListAssetGroups（另保留首次缺参失败）；没有真实上传、CreateAsset、Active审核或视频。下一步真实测试须单独批准新增存储/素材调用用量，原视频预算已满。


## 单图真实上传与创建检查（2026-09-09）

用户批准1张已有角色图≤10MB、上传1次/创建素材组1次/创建素材1次/查询10次，新增上限1元，失败即停、不生成视频。实际选择小杰已确认Seedream角色图，文件e67861da-20cf-558a-a193-1107c1e81277，640067字节；SHA256=eddf2f36897c7b9016a1c2de605b9fc82c9c97fe805a528fc817b8ad57d315fd。已在私有桶mengyuanaibucket完成上传（先对象HEAD，再禁止覆盖PUT，附SHA256校验），对象键m2-trusted/22589f8d-e8d6-4503-a997-31afc5f6e446/eddf2f36897c7b9016a1c2de605b9fc82c9c97fe805a528fc817b8ad57d315fd.jpg。

随后01:22:30 UTC创建素材组返回HTTP403，未取得GroupID，按失败即停停止；没有CreateAsset/GetAsset或视频请求。台账.local/m2-real/asset-single-1.json保留上传成功与创建失败，脚本拒绝失败后重跑。未取得实际账单，1元为批准上限而非已消费费用；上传对象仍保留，未额外删除。

暴露出诊断遗漏：transport对非200先抛固定HTTP码，未保存响应业务Code，因此此次403不能定位到具体IAM/资源项目/服务权益，不能直接声称账号无私域权限。已通过失败测试复现并修复：仅保留长度/字符受限且不含AK/SK的ResponseMetadata.Error.Code，不输出Message、正文或签名URL。15项传输层隔离测试和make check通过，未为取错误码重复外部请求。真实创建仍未通过，下一次创建需用户另行批准，优先复用已上传文件。


### 素材组额外重试授权与明确错误（2026-09-09）

用户随后新增批准最多3次创建素材组，合并费用仍在此次1元上限内。仅执行其中第1次，2026-09-09 01:30:12 UTC（北京时间09:30:12），HTTP403，安全业务Code=`SubscriptionRequired`；没有GroupID。剩余2次未用，不原样盲重试。独立台账.local/m2-real/group-retry-1.json保留次数与错误，未知/成功状态拒绝重发。没有再次上传、CreateAsset或生成视频。

该码指向服务订阅/开通状态，但尚不能断言一定需要新购买：用户此前确认有权限，需核对当前AK所属账号是否已生效所需权益及首次创建授权。官方CreateAssetGroup文档要求首次在控制台签署授权函，私域素材库指南说明全部功能需要高级创作权益。由用户或官方核对，代理不代签/购买；已有TOS成功对象保留可复用。待账号状态核实后，可使用剩余2次授权，无需重复申请同一调用许可。


最新用户决策：后续先以明确非人形卡通素材验收，暂停素材组路线及剩余2次创建调用，保留已有工程和失败证据。详见m2-real-verification.md的最新验收素材决策。
