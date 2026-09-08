# M1 纠错反馈独立审查

结论：Approved。针对基线 `16fba5b` 的 `services/backend/src/shortfilm/creation/execution.py`、`services/backend/src/shortfilm/creation/stage_schemas.py` 与 `tests/test_content_chain.py` 工作区 diff（含第二轮定位增强），未发现需要阻断的缺陷。

- 自定义 Pydantic 校验的 `msg` 被保留，模型可以读到“台词摘要必须与逐段正文一致”等具体原因；中文 JSON 不再转义，修复直指真实纠错反馈缺失。
- 错误投影仅保留 path/type/message，显式排除 input/context；现有自定义与语义错误均使用固定原因文字，没有插入无效正文或凭据。新增回归覆盖具体原因进入纠错消息、持久化诊断不含无效正文标记。字段路径仍可能含模型提供的未知字段名，Pydantic uuid_parsing 原因可能含首个无效字符，因此该诊断不是通用脱敏器。正确安全表述为“不持久化 input/context 或原始正文”；不能宣称任何输入字符均不保存。凭据不进入模型，本修复未引入凭据读取或传递通道，无需强制仅 value_error 白名单而丢失 UUID 等有用纠错原因。
- `validation_errors` 追加在同一租约 token 的最后一项 provider call；调用串行且 token 唯一，数组复制后赋值符合 JSONB 变更持久化要求。
- 校验契约、三次纠错上限、成功落库、失败/unknown 状态及租约完成保护均未放宽。回归的 `run()` 要求任务最终 succeeded，因此并非仅验证错误文字。
- 第二轮将台词一致性条件移至 Shot，原换行拼接与 strip 条件完全保留，BoardBody 的镜头/台词 ID 唯一性仍保留。错误现在定位到 shots/index；proposedShots 原本也会在 validate_board 中校验一致性，移动后提前得到具体镜头路径，不改变有效内容的接受条件。新增路径断言覆盖本轮目的。

验证边界：本次独立审查为静态代码审查；未运行真实模型、未读取任何凭据或 `.env`、未修改工程代码及 PRD。主任务报告第一轮 64 测试及契约/构建通过，第二轮完整回归正在执行；测试运行结果由主任务核验，本报告不代表真实 M1 闭环已通过。

主任务后续核验：第二轮完整回归64项、契约与构建、静态检查通过；最终真实主链和恢复事实见 `m1-real-verification.md`。
