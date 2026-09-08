# R4 AI 交互与提示词定制清单

本清单是首批提示词工程交付范围，包含28个交互点。“已演示”仅表示原型有交互，不代表已调用真实AI。可读取同目录 ai-prompt-inventory.json 作为机器清单。

## 一、全局契约

每个请求必须携带 projectId、market/targetLanguage、promptId/promptVersion、modelConfigVersion、sourceIds/sourceVersions、用户要求、输入素材。用户输入及上传文本放入数据区，不能覆盖系统约束。模型输出先解析、校验，再写新版本；不直接覆盖已确认内容。

提示词工程师每项交付：system模板、user模板、变量字典（类型/必填/默认）、输出JSON Schema、2个中文与2个英文正例、至少3个失败反例、质量评分标准和版本说明。故事/剧本/质检优先完成，随后镜头与媒体；可选增强项不阻塞主链。

| ID | 交互环节 | 输入 | 期望输出 | 核心验收 | 原型状态 |
|---|---|---|---|---|---|
| P01 | 创意→故事 | 一句话、写作指令、市场、风格 | 三份 title/logline/direction/text | 每批恰好3份；情节方向不同；语言匹配市场 | 已演示 |
| P02 | 故事多轮修改 | 故事正文、版本、对话、修改要求 | 新正文、changeSummary | 保留未要求改动的事实；新版本不覆写原版 | 已演示 |
| P03 | 故事→剧本 | 原故事、剧本指令、市场、风格 | scenes/actions/dialogues/estimatedSeconds | 可拍摄、人物动机一致、无需固定项目时长 | 已演示 |
| P04 | 剧本质检 | 原故事、当前剧本、双方版本 | summary/issues/evidence/suggestions | 同时检查贴合度、情绪、剧情和自身连贯性 | 已演示 |
| P05 | 剧本修复 | 原故事、当前剧本、完整报告、用户要求 | 新剧本、修改摘要、解决issueIds | 不得忽略报告或静默删剧情；修复后复检 | 已演示 |
| P06 | 剧本→分镜 | 已确认剧本、风格、画幅、资产清单、分镜Skill/提示词、分辨率 | shots[]，稳定shotId、dialogues[id,speaker,emotion,text,voice]、prompt、引用、时长 | 镜头覆盖原剧本；角色/场景/道具/站位引用一致 | 已演示 |
| P07 | 分镜质检 | 原剧本、分镜表、源版本 | schemaVersion/scriptId/baseBoardVersion/issues/proposedShots | 定位到shotId；漏信息、情绪、动作逻辑有证据；schemaVersion=2，校验每段lineId和台词摘要一致 | 已演示 |
| P08 | 分镜修复 | 原剧本、分镜、质检报告、用户要求 | 完整建议版、changeSummary | 保留镜头ID与合法引用；服务端事务原子应用；schemaVersion=2，校验每段lineId和台词摘要一致 | 已演示 |
| P09 | 台词生成/优化 | 剧本、当前镜头、人物、情绪、市场 | dialogues[speaker,text,emotion] | 不添无依据人物；配音文本与字幕同源 | 独立生成待接入 |
| P10 | 提取资产 | 已确认剧本与分镜、已有资产字典 | assets[kind,name,description,sourceIds] | 区分角色/场景/道具/服饰/站位，去重且可追溯 | 待接入 |
| P11 | 角色参考图 | 角色身份外形、服饰、风格、参考图 | imageUri/assetId/version | 身份稳定；可选三视图，避免场景混入主体 | 全片管理与图片示例 |
| P12 | 场景参考图 | 时代地点、光线、景别、风格 | imageUri/assetId/version | 空间与剧本一致，明确室内外 | 全片管理与图片示例 |
| P13 | 道具参考图 | 道具功能、外观、比例、风格 | imageUri/assetId/version | 关键道具特征不漂移 | 全片管理与图片示例 |
| P14 | 服饰参考图 | 角色、时代、服饰设定、风格 | imageUri/assetId/version | 与角色/时代一致，服饰可单独复用 | 待接入 |
| P15 | 站位图 | 镜头、角色位置、场景布局、运动方向 | imageUri + positions/labels | 左右关系、朝向与动作轴线明确 | 通用参考图演示 |
| P16 | 镜头提示词生成/优化 | 镜头、剧本、风格、可用assetIds | prompt + referencedAssetIds | 正文引用与提交图片严格一一对应 | 编辑已实现，AI待接入 |
| P17 | 视频生成 | 镜头提示词、图片、画幅、秒数、前镜尾帧 | videoUri/duration/taskId | 参考图版本冻结，尾帧来自指定前镜视频 | 已演示 |
| P18 | TTS生成 | shotId、lineId、逐段台词、角色、语言、音色、情绪、语速、模型与指令版本 | audioUri/duration/可选wordTimestamps | 不擅改台词；语言/发音与人物一致 | 已演示 |
| P19 | 配乐生成 | 情绪段落、节奏、实际时长、风格 | audioUri/duration | 与台词让位关系明确，无突兀截断 | 待接入 |
| P20 | 风格推荐 | 剧本、市场、现有风格候选 | recommendations[styleId,reason] | 理由对应内容，不创造不可用模板ID | 待接入 |
| P21 | 风格模板建立/完善 | 风格描述、视觉参考、约束 | name/visualRules/negativeRules | 角色、色温、光线、镜头语言可以复用 | 已演示 |
| P22 | 资产匹配推荐 | 镜头资产需求、可用资产元数据 | matches[requirementId,assetId,reason] | 引用存在，缺失返回unmatched，不编造资产 | 待接入 |
| P23 | 声音设定辅助 | 角色、语言、情绪、可用voiceIds | voiceId/语速/表现参数 | 使用可用音色ID，不擅自克隆真人声音 | 待接入 |
| P24 | 字幕语言润色（可选） | 台词、市场、字幕长度规范 | subtitleText + sourceDialogueIds | 不改变事实；时间轴由音频对齐工具计算 | 待接入 |
| P25 | 创意导演对话 | 当前创意、历史对话、修改要求、市场 | proposal/changeSummary/baseVersion | 用户采用前不改变正文；过期建议拒绝采用 | 已演示 |
| P26 | TXT选题提炼 | 上传完整原文、文件名、来源ID | 单一title/logline，正文保持原文 | 只提炼1张卡；不得改写或截断原文 | 本地规则演示 |
| P27 | 剧本导演对话 | 原故事、当前剧本、对话、要求、源版本 | 剧本建议版/changeSummary | 保留原作事实；采用后旧报告失效，重新质检 | 已演示 |
| P28 | 分镜导演对话 | 原剧本、目标镜头、图片ID、对话、要求 | 镜头建议版/changeSummary | 保留稳定图片ID及所有台词；采用后复检 | 已演示 |

## 二、优先级与配置映射

P0主链：P01–P08、P11–P13、P15、P17、P18、P25–P28。P1增强：P09、P10、P14、P16、P19–P21。P2可选：P22–P24。系统按独立交互key登记模型和提示词，细分模板通过上述key独立登记；故事修改、剧本修复、分镜修复不能只靠重新生成的通用模板。图像类按资产kind分派，不要求采用同一个供应商。

图像、视频、TTS接口通常是文字与结构化参数并存，不能把音色、画幅、时长、参考图URI全部塞进一段提示词。TTS供应商不支持自由指令时使用text/voiceId/speed等参数，不伪造“系统提示词”能力。

## 三、关键结构示例

故事批次：
```json
{"schemaVersion":1,"batchId":"batch-1","stories":[{"id":"s1","title":"...","logline":"...","direction":"重逢","text":"...","estimatedSeconds":55},{"id":"s2","title":"...","logline":"...","direction":"悬念","text":"...","estimatedSeconds":62},{"id":"s3","title":"...","logline":"...","direction":"抉择","text":"...","estimatedSeconds":48}]}
```

质检报告：
```json
{"schemaVersion":2,"scriptId":"script-2","baseBoardVersion":3,"summary":"动作衔接遗漏","issues":[{"id":"issue-1","shotId":"shot-2","type":"action","severity":"major","evidence":"原剧本先取出包裹再递交","suggestion":"补齐取件动作"}],"proposedShots":[{"id":"shot-2","dialogue":"快递员：老师，这是给您的。","dialogues":[{"id":"line-1","speaker":"快递员","emotion":"真诚","text":"老师，这是给您的。","voice":"warm-1"}],"prompt":"先取件再递交 @[asset-1]"}]}
```

上例仅展示单镜，真实 proposedShots 必须包含完整镜头集合。写入前校验源版本一致、ID无重复/遗漏、引用存在、字段类型合法。结构不合法时返回校验反馈让模型重试，有限次数后显示错误并保留原内容。

修复请求必须包含原文、当前版、报告全文和基准版本。重复应用相同报告应无副作用；内容版本已变则拒绝应用。报告说明“无问题”并不代表人工审片可以省略。

## 四、不需要提示词的环节

项目统计、TXT读取（选题语义提炼另见P26）、分页/排序、版本保存、任务日志、图片ID解析、视频末帧截图、音频时间对齐、SRT生成、视频编码与下载均由确定性程序完成。字幕翻译/润色才需要语言模型；字幕时间戳不应由大模型猜测。不要为这些工具步骤采购无必要的提示词。

## 五、统一验收用例

中文与英文市场分别验证输出语言；导入原文不被覆盖。输入包含“忽略系统要求”等文本时仍按内容数据处理。长故事不得静默截断；人物/道具同名时依赖ID。缺图、缺模型能力、无合法尾帧、JSON错误、超时都应有明确失败返回。中途修改配置后，已发任务仍使用发起时快照。每个模板注明适用模型能力与变量边界，禁止把示例占位符当作有效素材URI。

首个本地工程验证优先接入一句话主链；P26为随后接入的TXT入口，产品范围继续保留。P10可先用人工建立元素清单，P19可先用上传配乐；自动化增强不阻塞真实成片。输出校验、服务端ID分配、配置快照与落库契约见 [R5 技术实现规划](/content/reference/technical-implementation-plan.md)。
