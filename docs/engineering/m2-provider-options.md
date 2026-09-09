# M2 已确认供应商与账户配置边界

2026-09-09核对官方资料。用户已接受推荐组合与末帧作为多图参考的语义；没有创建付费任务、没有获取凭据。

建议图像使用火山引擎Seedream（先评估4.5参考图能力），配音使用MiniMax speech-2.8-hd；视频选用火山引擎 `doubao-seedance-2-0-mini-260615` 的多参考模式，仍须真实验收证明效果。此建议依据接口能力与当前工程适配范围，不代表实测画质/音质比较。

- [Seedream官方说明](https://www.volcengine.com/docs/6492/2221472?lang=zh)：支持文字和参考图输入，适合元素图及站位图适配。
- [MiniMax同步配音](https://platform.minimaxi.com/docs/api-reference/speech-t2a-http)：列出speech-2.8-hd、中英文、voice_setting和真实音频返回；返回长度/用量，仍须本地解码核验。
- [Seedance创建视频任务](https://www.volcengine.com/docs/82379/1520757)：首帧、首尾帧、全模态参考是互斥模式。多参考模式可用提示词间接指定首帧，但不等同于严格first_frame输入。当前页面包含Seedance2.5，账户可用性/模型ID/价格仍需在用户选定后核对。

已确认：上一镜真实尾帧进入多图参考并由提示词约束连续性；不能宣称严格首帧一致。用户已提供账号开通的完整视频模型 ID，Seedance 1.5 不用于当前多参考链。

付费测试尚未批准。候选最小方案及数量上限见m2-implementation-plan.md；选定确切模型、规格、账户计费后补人民币上限再请求批准。凭据继续从系统设置的安全页面配置，不能要求聊天传密钥。媒体类别已复用现有密码框保存流程；提供供应商配置草稿按钮，视频预设已填用户提供的完整模型ID。未迁移生产时仍不能声称当前生产页面已有新界面。


2026-09-09 用户补充：已开通视频模型 `doubao-seedance-2-0-mini-260615`，已写入前端配置草稿预设，尚未写入生产配置或调用。原文“等待完整模型 ID”为此前状态。真实单价及费用上限仍须在付费验收前确认；官方公开产品页列 Mini 无视频输入23元/百万tokens，但不能仅按这个单价宣称已核算出全部图像/语音/视频费用：[火山方舟产品价格](https://www.volcengine.com/product/ark)。

最新：预算已获用户批准（30元及实施计划用量上限），尚未执行；页面媒体密钥缺失。MiniMax默认地址已修正为官方同步语音文档中的https://api.minimaxi.com/v1；旧api.minimax.cn不再作为预设。公开价格核对：Seedream4.5 0.25元/图、MiniMax HD 3.5元/万字符、Seedance2.0 Mini无视频输入23元/百万tokens。视频token换算上限仍须在实际提交前核实，未核算不能调用视频。来源：https://www.volcengine.com/product/doubao、https://platform.minimaxi.com/docs/guides/pricing-paygo、https://platform.minimaxi.com/docs/api-reference/speech-t2a-http。
