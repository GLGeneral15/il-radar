---
name: il-radar
description: AI+信息素养备赛搜题工具。先比对本题库（1017 题，命中即直接作答），未命中再按证据缺口检索：复用 6 张稳定规则卡、252 个已登记网站入口，用 Playwright 控制可见 Chrome 取证，输出答案、依据、来源与置信度。
whenToUse: 用户要求"准备答题"、发来信息素养题（题干+选项/截图）、要求核验答案出处、或需要检索知网/万方/维普/读秀等数据库时使用。
---

# 信息素养雷达（il-radar）

面向 AI+信息素养大赛的备赛与答题工具。工作方式分两级：

```
收到题目
  ├─ 比对题库 → 命中 → 直接作答（不再复验）
  └─ 未命中 → 按证据缺口检索：题内推导 → 规则卡 → 官网/API → 可见 Chrome
```

## 使用边界

- **不做**：自动开始考试、代替选择考试选项、交卷、向他人发送结果。
- 打开的页面不代表已登录、有全文权限或检索成功；登录与验证码由用户在 Chrome 原窗口完成，**无需索要密码**。
- 题库由用户提供并确认，命中即按库内答案作答，**不再独立核验**；未命中时取得的外部证据才标注来源与置信度。
- 来源目录请各个赛区自行核对。

## 准备答题

用户说"准备答题"时执行：

```powershell
& '<技能目录>\_dsh\ailit.ps1' prepare
```

预热可见 Chrome、252 份网站流程、6 张规则卡与题库，并打开默认五站（知网、万方、维普、读秀、超星汇雅），只回报**简短摘要**。

- 只准备指定站点：`-Sources cnki,wanfang`
- 只准备浏览器与缓存、不开站点：`-NoSources`
- `status: partial` 且个别站点 `failed` 属常见情况（超时/验证码/需登录），页面通常已打开并停在登录页，用 `pages` 确认即可，不要重试或认定站点不可用
- `status: blocked` 表示浏览器未连上，重试一次即可

## 答题流程

### 第 1 级：比对题库（不需要 Chrome）

把题干与**当前**选项写成 JSON：

```json
{
  "id": "q1",
  "type": "single",
  "question": "完整题干（含空括号）",
  "options": { "A": "选项文字A", "B": "选项文字B", "C": "...", "D": "..." }
}
```

`type` 取 `single` / `multiple` / `judge`（判断题选项写 `{"A":"正确","B":"错误"}`）。

```powershell
& '<技能目录>\_dsh\ailit.ps1' lookup -QuestionFile '.\q.json'
```

**命中（`matched`）就直接作答，不要再去核验。** 用返回的 `answer_labels` 与 `answer_texts`。

匹配要求：同题型 + 题干一致 + 全部选项文字一致。以下变化**不影响命中**：选项换序（按文字重映射字母）、全角/半角括号差异、多余空格、末尾标点差异。

以下变化**会导致不命中**，此时按第 2 级检索：

- 题干被改写、增删限定语或数字
- 任一选项文字不同
- 题型判断错误（`single` 写成 `multiple` 等，会直接掉到 27% 命中率）

题库命中时来源写"用户提供题库"，不要声称刚访问官网或已独立核验。

### 第 2 级：按证据缺口检索

按顺序走，够用即停：

1. **题内推导** —— 数据完整时直接计算（查全率/查准率等），不查库不开浏览器
2. **稳定规则卡** —— 6 张：查全/查准率、Boolean 语义、ISBN、ISSN、DOI、倒排索引
3. **官网直连** —— 优先官方页面与官方 API，见 `references/retrieval.md`
4. **可见 Chrome** —— 需要站点交互时

```powershell
& '<技能目录>\_dsh\ailit.ps1' call -Method findRecipes -Args '.\args.json'
& '<技能目录>\_dsh\ailit.ps1' search -QuestionFile '.\q.json' -Recipe '<recipeId>' -Params '.\params.json'
& '<技能目录>\_dsh\ailit.ps1' open -Url 'https://...'
& '<技能目录>\_dsh\ailit.ps1' pages
& '<技能目录>\_dsh\ailit.ps1' call -Method observe -Args '.\args.json'
```

`-Args` 支持 `{"pageIndex":0}` 或 `{"url":"https://..."}`；省略时读取最后一个非空白页。

## 全文与页面核对（易错，务必遵守）

题目问"第 n 页""最后一个单词""文件大小""共几页"时，答案就在指定版本的全文字节里。违反以下任一条会直接答错，细节见 `references/retrieval.md#全文与页面核对`：

1. **扫描件无文本层 → 改用页面图像识别。** 文本提取为空说明该 PDF 没有文本层，**不得**据此判断"页面无内容"；导出该页图像后识别。
2. **按题目页码定位前，先验证印刷页码与 PDF 物理页序的偏移。** 前置页（封面/目录/罗马数字页）会造成偏移，直接按 PDF 序号取页会取错；至少核对两页页脚数字。
3. **题目指定工具时用该工具的口径。** 同一指标在不同来源可能相差约一成；排序一致也不代表数值可替换。

## 答复格式

```text
答案：C。
依据：（题库命中写"题库命中·原题号"；推导写"题内数据推导"；检索写一句关键依据）
来源：（题库 / 具体原始页面 / 规则卡）
置信度：95%（高）
```

多选写 `答案：A、C、D。`，判断写 `答案：正确。` / `答案：错误。`。证据不足时写"待核验"与一个会改变答案的关键缺口。不展示工具过程、自检清单或用时。

## 常用命令

| 命令 | 用途 |
|---|---|
| `health` | 守护进程、版本、浏览器状态（排障先跑这个） |
| `bank-status` | 题库条数与可用条数 |
| `prepare` | 预热 Chrome、资料与五站 |
| `lookup` | 题库比对（不需要浏览器） |
| `search` / `open` / `pages` | 按流程检索 / 开页 / 看页 |
| `call -Method <name>` | 调用会话方法：`observe`、`inspect`、`findRecipes`、`beginQuestion`、`saveAnswer` 等 |
| `close` / `shutdown` | 关浏览器 / 停守护进程（**仅用户明确要求时**） |

## 排障

- 守护进程启动失败：读 `paths.json` 指向的 `daemonDir\daemon.log`
- 命令长时间无响应：守护进程**逐条**处理请求，`prepare`/`search` 可能跑几十秒到几分钟，其它命令排队；**不要重发**
- `code_status: reload_required`：技能文件与已加载版本不一致，执行 `shutdown`，下次调用自动加载新代码，Chrome 与登录态由持久 profile 保留
- 题库报"摘要无效"：题库文件被改动后未重算摘要，用 `tools/build-digest.cjs` 重算

## 深入资料

- `references/question-bank.md` — 题库格式、匹配边界与贡献方式
- `references/retrieval.md` — 官方端点与检索语法
- `references/browser.md` / `browser-api.md` — 浏览器接口与流程
- `references/recipes.md` — 网站检索流程与示例
- `references/exam-scope.md` — 命题范围
- `references/sites/*.json` — 252 个网站入口流程
