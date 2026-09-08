# 创作领域（M1 故事子阶段）

`router/service` 管理创意、故事追加版本、精确选择、项目隔离与建议采用；`execution` 通过持久任务调用 `provider`（DeepSeek/OpenAI兼容文本传输），只有完整输出通过 Schema 才原子落库。`prompts` 定义 P01/P02 revision 2，`retry` 保留失败/unknown记录并限制一个原任务只有一个重试子任务。

真实DeepSeek验收等待凭据注入，见根目录 `docs/engineering/m1-story-verification.md`。剧本、分镜与质检仍是后续M1范围。不得把Demo localStorage或测试替身状态移作正式生成数据。
