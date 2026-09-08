# 最新计划差距审查 · 2026-09-08

审查对象 b8d0c82 与工作区更新后的 PRD/R4/R5。原始 M0 标签 m0-baseline-20260908 不移动。用户 PRD/Demo 未提交变更保留，已保存 tracked diff 到忽略目录 .local/reviews/user-prd-before-m0-m1.patch；未跟踪原型文件继续原地保留。

## 结论与必要调整

1. M0 任务事务、幂等、租约、未知结果保守恢复与版本保存可复用。本轮基线 make test：22 passed，OpenAPI matches，TypeScript/Vite build passed。两条上游弃用警告，不影响行为。
2. ProjectCreate 没有画幅/分辨率，generation_settings 为空，与 V8 冲突。需增量迁移只补缺失字段及来源、持久版本与创建/修改接口。
3. settings 仅只读环境概览；writing_mode 只有 prompt/skill 枚举。与 V9/V10 的具名方法、共用资源版本、类别默认/场景覆盖冲突，需新增配置领域服务并在任务发起时冻结实际配置。
4. creation 仅 story.generate/story.revise；剧本/分镜页面为空。必须扩展阶段内容、来源与确认、报告/决定记录、全量分镜校验。保留追加版本及 Proposal 采用语义，抽取公共跨阶段逻辑；不改写任务底座。
5. 文档和测试需区分替身与真实供应商：尚无 DEEPSEEK_API_KEY 注入，不能宣称真实 M1 通过。官方 Chat Completions 文档复核仍支持 deepseek-v4-pro、thinking disabled、JSON object；现有运输适配无需更换供应商或模型。

## 本轮验收重点

版本冲突/重复提交/迟到结果不覆盖；报告失败与内容不合法分开；未知结果仅显式确认重试；方法/模板/模型/规格变更不影响已发任务；完整 shot/line ID 校验及原子采用；页面重载草稿与幂等键不丢失；原 M0 数据迁移与真实 Worker 测试继续通过。

技术依据：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。

升级前备份：`.local/backups/20260908T104642732412Z`，独立恢复演练通过，2项目/1媒体文件。其后原生库已升级至 `20260908_m1_content`；升级后备份 `.local/backups/20260908T120606312297Z` 再次独立恢复通过，既有2项目/1媒体及内容/任务保留。
