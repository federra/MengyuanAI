# 分镜 JSON 导入与整表刷新协议（V13）

目标：用户按模板导入JSON文件，校验并确认后，当前分镜表的所有行整体替换为导入内容；重新打开页面仍是这份新表。上传附件、追加行或仅生成后台任务均不算完成。

## 一、文件契约

- [JSON模板](/content/reference/contracts/storyboard-import.example.json)；[JSON Schema](/content/reference/contracts/storyboard-import.schema.json)。格式名 `shortfilm-storyboard-import`，`schemaVersion:1`，UTF-8，≤1MB，1～100镜。
- 每镜：`id`、`duration`、`prompt`、`assets[]`、`dialogues[]`、`bindings`，可选`generation`。镜头按数组顺序；`generation`中缺项继承项目模型、画幅和分辨率。
- 图片描述包括ID、类别、名称、描述；台词包括ID、角色、情绪、正文、音色。ID以字母开头，仅含字母/数字/下划线/连字符，在文件内全局唯一；不按同名文本连接。每镜bindings.assetIds与提示词中`@[id]`集合相等，且必须存在于本镜assets；dialogueIds完整对应本镜台词集合。
- 拒绝未知字段、重复ID、失效引用、非法枚举/范围。禁止文件指定项目归属、已完成状态、文件路径或媒体URL；图片描述在导入后作为待制作素材。正文作为内容数据处理，不能执行文件中的指令。
- 文件级ID只是导入临时标识，提交时由服务器映射到项目内新ID；返回映射表以追溯。原表对应的素材与媒体保留历史，不按原序号误接新镜头。

## 二、后端数据流程（待工程接入）

建议 `POST /projects/{projectId}/storyboard/import/preview`：携带`sourceScriptVersionId`、`baseBoardVersionId`与导入包，校验文件、JSON Schema、引用闭包、模型参数和归属，不修改当前表；返回`previewId`、规范化内容哈希、基准版本、镜头/台词/秒数统计及字段路径错误。解析器还需拒绝重复JSON键、NaN/Infinity与过深嵌套。

建议 `POST /projects/{projectId}/storyboard/import/commit`：携带`previewId`、内容哈希、基准版本和幂等键。锁定当前分镜记录，复核来源剧本与分镜版本；预检后内容发生变化必须重新预检，版本冲突返回409。

**一个PostgreSQL事务完成：** 新建导入批次与ID映射 → 新建图片描述/元素、逐句台词和分镜整表版本 → 保留旧版本及媒体关联 → 切换当前分镜版本指针 → 清除新版本的确认状态 → 标记依赖旧表的当前导出/时间轴需重建 → 提交事务。任一步失败全部回滚，不能出现半张新表；同一幂等键返回同一提交结果，不重复建版。

响应返回新`boardVersionId`、源剧本版本、完整规范化`shots[]`、映射和统计。前端仅在成功响应后用返回的完整数组替换当前表，清空旧表的行选择/编辑缓存、回到首行，显示新版本；禁止逐行追加或保留漏掉的旧行。响应丢失时按幂等键查询，不能误报失败后再建一份。刷新页面的GET必须读取已提交的新版本。

质检在提交后通过事务outbox发起，报告绑定新版本。报告错误、超时或发现问题都不回滚成功导入；助手展示建议，是否采用由用户选择。运行中的旧视频任务保留其旧版本快照，迟到结果只能进入旧版历史，不能写入导入后的镜头。

## 三、与现有后端的适配

本轮已只读核对 `services/backend/src/shortfilm/creation/stage_schemas.py`：现有BoardBody为schemaVersion=2，含scriptId与shots；DTO拒绝额外字段，已有镜头/台词ID唯一及台词摘要一致性校验。因此**用户导入包v1与内部BoardBody v2是两个不同契约**，不得覆盖原版本字段或直接把导入文件传给StageSave。

适配器将当前确认剧本UUID写入scriptId、导入临时ID映射到新实体ID，将assets转换为项目实体/参考图记录和References中的UUID；`dialogue`按各段text换行拼接，不添加说话人或情绪标签（这是现有后端规则）。演示表的带角色摘要仅用于显示，不作为后端协议。单镜generation覆盖在镜头配置资源中保存，视频任务提交时解析，不能作为额外字段硬塞进现有Shot DTO。

此文与Schema是当前需求/实现规划；本轮仅实现了原型里的预检、历史保存、整表替换与本地刷新，未新增上述生产API或数据库迁移。
