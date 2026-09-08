> 2026-09-07 当前调整：正文/输入/按钮 15px，辅助 13–14px；全局顶栏仅保留「配置」及主题切换，配置内含提示词、模型、音频模型和风格模板；次要行操作折叠。业务页采用四步导航和独立内容页，旧截图只作为配色参考。

# DESIGN · 双主题视觉基线

> G3 设计规范 v1.1（用户最新密度修订优先）｜当前 MVP：一句话到短片、故事到短片。G2 已按用户范围补充通过；用户已明确“同意”本规范，现制作组件与状态展示页；G3 整体仍待展示页审核。所有色值、尺寸为拟定规范，不冒充截图原始 CSS。

## 一、视觉来源与设计原则

权威方向来自用户提供的“角色设置”截图：深海军蓝底色、灰蓝面板、浅色文字、描边控件及便于比较的表格；用户随后明确要求浅/深切换按钮和醒目适中的字体。原图已保存，以下浅色方案是基于同一视觉语言的补充设计。

<img src="/content/reference/assets/user-visual-reference-01.png" alt="用户提供的深色角色设置视觉参考" style="display:block;max-width:100%;height:auto">

优先清楚阅读与局部修订：剧本、分镜、审核意见和提示词使用正常正文尺度；长内容换行、展开或滚动，不能为塞入更多列缩小字体。密度通过对齐、间距和分组控制。沿用中小圆角和细边框，不用大面积渐变、厚重阴影或与创作无关的装饰。

截图中央播放按钮、时间浮层及指针不作为产品组件；资产库、三视图和并发数等截图功能不自动纳入本期。首版不制作参考视频入口、账号、角色或权限管理页。

## 二、双主题颜色与生效行为

下表使用相同语义变量，切换主题只更换颜色值。素材图片、视频及导出成片保持原始颜色。表中方块用于对照色彩，不是可操作原型。

| 用途 / 变量 | 深色 | 浅色 |
| --- | --- | --- |
| 页面底色 / `bg` | <span style="display:inline-block;width:16px;height:16px;background:#0F1C31;border:1px solid #8290a3;vertical-align:middle"></span> `#0F1C31` | <span style="display:inline-block;width:16px;height:16px;background:#F4F6FA;border:1px solid #8290a3;vertical-align:middle"></span> `#F4F6FA` |
| 面板 / 表格 / `surface` | <span style="display:inline-block;width:16px;height:16px;background:#26344A;border:1px solid #8290a3;vertical-align:middle"></span> `#26344A` | <span style="display:inline-block;width:16px;height:16px;background:#FFFFFF;border:1px solid #8290a3;vertical-align:middle"></span> `#FFFFFF` |
| 输入 / 素材槽 / `input` | <span style="display:inline-block;width:16px;height:16px;background:#17253B;border:1px solid #8290a3;vertical-align:middle"></span> `#17253B` | <span style="display:inline-block;width:16px;height:16px;background:#F8FAFD;border:1px solid #8290a3;vertical-align:middle"></span> `#F8FAFD` |
| 悬停背景 / `hover` | <span style="display:inline-block;width:16px;height:16px;background:#31435E;border:1px solid #8290a3;vertical-align:middle"></span> `#31435E` | <span style="display:inline-block;width:16px;height:16px;background:#EDF2F8;border:1px solid #8290a3;vertical-align:middle"></span> `#EDF2F8` |
| 选中背景 / `selected` | <span style="display:inline-block;width:16px;height:16px;background:#284666;border:1px solid #8290a3;vertical-align:middle"></span> `#284666` | <span style="display:inline-block;width:16px;height:16px;background:#E6F0FF;border:1px solid #8290a3;vertical-align:middle"></span> `#E6F0FF` |
| 控件边框 / `border` | <span style="display:inline-block;width:16px;height:16px;background:#7388A4;border:1px solid #8290a3;vertical-align:middle"></span> `#7388A4` | <span style="display:inline-block;width:16px;height:16px;background:#7D90A9;border:1px solid #8290a3;vertical-align:middle"></span> `#7D90A9` |
| 正文 / `text` | <span style="display:inline-block;width:16px;height:16px;background:#F1F5FB;border:1px solid #8290a3;vertical-align:middle"></span> `#F1F5FB` | <span style="display:inline-block;width:16px;height:16px;background:#18263A;border:1px solid #8290a3;vertical-align:middle"></span> `#18263A` |
| 次要文字 / `secondary` | <span style="display:inline-block;width:16px;height:16px;background:#B6C6DA;border:1px solid #8290a3;vertical-align:middle"></span> `#B6C6DA` | <span style="display:inline-block;width:16px;height:16px;background:#41536C;border:1px solid #8290a3;vertical-align:middle"></span> `#41536C` |
| 辅助文字 / `muted` | <span style="display:inline-block;width:16px;height:16px;background:#9DAEC5;border:1px solid #8290a3;vertical-align:middle"></span> `#9DAEC5` | <span style="display:inline-block;width:16px;height:16px;background:#586B85;border:1px solid #8290a3;vertical-align:middle"></span> `#586B85` |
| 主操作背景 / 焦点 / `accent` | <span style="display:inline-block;width:16px;height:16px;background:#9BCAFF;border:1px solid #8290a3;vertical-align:middle"></span> `#9BCAFF` | <span style="display:inline-block;width:16px;height:16px;background:#1F5EA8;border:1px solid #8290a3;vertical-align:middle"></span> `#1F5EA8` |
| 主操作文字 / `on-accent` | <span style="display:inline-block;width:16px;height:16px;background:#102138;border:1px solid #8290a3;vertical-align:middle"></span> `#102138` | <span style="display:inline-block;width:16px;height:16px;background:#FFFFFF;border:1px solid #8290a3;vertical-align:middle"></span> `#FFFFFF` |
| 成功文字 / `success` | <span style="display:inline-block;width:16px;height:16px;background:#8FDBC0;border:1px solid #8290a3;vertical-align:middle"></span> `#8FDBC0` | <span style="display:inline-block;width:16px;height:16px;background:#166349;border:1px solid #8290a3;vertical-align:middle"></span> `#166349` |
| 提醒文字 / `warning` | <span style="display:inline-block;width:16px;height:16px;background:#F1CD83;border:1px solid #8290a3;vertical-align:middle"></span> `#F1CD83` | <span style="display:inline-block;width:16px;height:16px;background:#865515;border:1px solid #8290a3;vertical-align:middle"></span> `#865515` |
| 错误 / 危险文字 / `danger` | <span style="display:inline-block;width:16px;height:16px;background:#F2A4B3;border:1px solid #8290a3;vertical-align:middle"></span> `#F2A4B3` | <span style="display:inline-block;width:16px;height:16px;background:#A82A47;border:1px solid #8290a3;vertical-align:middle"></span> `#A82A47` |

危险、成功及提醒色只用于对应标签、图标、边缘或文字，反馈同时提供明确文字，不仅靠颜色。普通分隔线可降低边框色强调；可操作输入边界与焦点保持清楚。禁用状态采用明确禁用文案和不可交互语义，不将仍可运行的按钮做成禁用样式。

全局右上方设置文本加图标按钮，文案为“切换至浅色”或“切换至深色”，表达下一次操作。建议首次默认深色，之后记住本地使用者选择，跨页、刷新保留；无需新增账号或设置页面。切换不刷新业务数据、不清空输入、不改变任务或播放状态。两主题共用页面、结构和组件 ID，不维护两套独立页面。

配色计算检查：正文、次要/辅助文字、主按钮文字和状态文字在对应背景上的亮度对比值均不低于本方案设定的 4.5:1 检查阈值；当前最小值为 5.21:1。此结果只验证表内配色组合，不能替代后续原型中的字号、实际背景、焦点及完整状态检查。

## 三、字体、间距与控件尺寸

字体建议使用系统中文无衬线栈：`-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`。不引入外部字体加载依赖；跨平台字形可能略有差异。正文常规字重 400，控件与小标题 500–600，页面标题 600；仅模型标识、参数值等必要字段使用等宽字体。

| 用途 | 字号 / 行高 | 使用规则 |
| --- | --- | --- |
| 页面标题 | 24px / 34px | 一页一个主要标题 |
| 区块标题 | 18px / 28px | 剧本、分镜、问题列表等区域 |
| 正文、表格内容、输入、按钮 | 15px / 24px | 剧本、审核意见、提示词不降级成辅助字 |
| 表头、辅助说明、状态标签 | 13–14px / 22px | 只承载次要信息 |
| 长文编辑 | 15px / 26px | 剧本、故事、提示词及分镜长描述 |

全局间距以 4px 为最小步长，常用 8/12/16/24/32px。业务按钮、输入和下拉高度约 38px，水平内边距 12–16px；图标按钮至少 38 × 38px 并有可访问名称。表格单元格建议内边距 12–16px，长内容顶对齐，不能靠固定短行高裁切。控件圆角 6px、面板 8px、标签 4px，边框 1px；浮层仅使用轻阴影辅助层级。

焦点轮廓使用 accent 色，建议 2px 实线及 2px 外偏移；聚焦不改变布局。错误输入同时说明字段和修复动作。200% 浏览器缩放下允许合理滚动、折叠侧栏和展开编辑，关键操作必须可访问；不得将整个页面缩小来抵消用户放大。

## 四、页面框架与交互视觉

产品原型使用 PC 固定视口 1440 × 900。业务页顶部工具栏 56px、横向四步导航、内容区外边距 28px；组件展示页保留参考侧栏、主区域间距 16–24px。默认竖屏是视频画幅，不是手机端原型。窗口不足时采用区域滚动和可折叠导航；具体模块保证长文编辑与媒体预览均能访问。

首页只有“一句话创作”“故事改编”两个入口，保留作品创建、保存和继续编辑。模型/提示词配置作为必要工具入口；不增加账号、权限及其他非主线导航。顶部统一放产品标识、配置入口与主题切换，主要运行按钮就近放在当前阶段。

剧本页以文字编辑为主；分镜和素材页用对齐的表格/卡片便于比较。质检建议左侧约 60% 对照内容、右侧约 40% 问题与修改预览，可展开长文；这是产品质检页的布局，独立于 PRD 阅读底座的文档/原型对照比例。音视频预览使用稳定媒体区域，文字与控制条不受视频画幅挤压。

公共视觉覆盖按钮、文本域、下拉、复选框、表格、素材卡片、问题标签、修改预览、提示词面板、模型配置、版本标记、进度及播放区域。行内动作靠近对象；删除使用低强调危险样式；同一区域仅突出当前主操作。图标统一使用简洁线性风格，必要时配文字，不依赖截图中的播放叠加物。素材演示来源在模块制作时登记，不将占位素材当作实际模型结果。

后续状态页覆盖初始空、编辑未保存、加载/排队/运行、生成成功、部分失败/失败、重试、取消处理中、审核问题/通过/待确认、内容或素材待更新、配置缺失与变量错误、保存失败/离线。每种状态需要文字原因及可执行恢复入口；用户权限拒绝状态不在本期范围。运动仅用于帮助识别进度与反馈，支持减少动效偏好。

## 五、确认范围与下一步

本轮修订覆盖：双主题配色、主题切换与偏好保持、15px 正文及 13–14px 辅助字、控件尺寸与 PC 视口、页面框架及状态视觉原则。以上是具体设计提案，用户要求的双主题与清晰字号本身已确认。

本规范确认后，完善 `reference/components-and-states.md` 并制作 `components` / `states` 两个参考展示页，演示主题切换、文字输入、交互反馈与状态；检查两主题、键盘、缩放、保存/刷新及标注定位后再请审核 G3。当前没有把初始化模板页当作已完成的设计成果，正式功能页从 G4 逐模块制作。


**设计规范确认记录：** 2026-09-07 用户明确回复“同意”，通过 DESIGN v1.0。组件与状态展示单独提交 G3 审核，不将此确认视为后续功能模块通过。


本轮视觉补充：分镜表增加站位参考及独立音频列；低频动作收进更多菜单，提示词/模型/音频模型/风格模板收进统一配置入口。深浅主题共享布局，剧本与分镜独立承载。参考图片：assets/user-storyboard-reference.png。
