# il-radar · 信息素养雷达

面向 **AI+信息素养大赛** 的备赛与答题工具。两级工作方式：

```
收到题目
  ├─ 比对题库（1017 题）── 命中 ──► 直接作答
  └─ 未命中 ──► 按证据缺口检索
                  ├─ 题内推导（查全率/查准率等）
                  ├─ 6 张稳定规则卡（Boolean / ISBN / ISSN / DOI / 倒排索引）
                  ├─ 官网与官方 API
                  └─ 可见 Chrome（252 个已登记网站入口）
```

**设计取向：能确定就直接答，不能确定就去查。**

## 能力与边界

| 能做 | 不能做 |
|---|---|
| 题库比对：命中即答，支持选项换序 | 自动开始考试、代替选答案、交卷 |
| 题内推导与计算题 | 绕过网站登录、验证码或付费墙 |
| 可见 Chrome 持久会话，跨题保留登录态 | 保证 252 个入口都能自动检索 |
| 按官方 API / 官网直连取证 | 独立核验题库答案的原始出处 |

**关于题库**：题库由用户提供并确认。命中时按库内答案作答，**不再独立核验**；未命中时取得的外部证据才标注来源与置信度。

## 快速开始

### 环境

- Windows + PowerShell + Node.js 20+
- 本机已安装 Google Chrome

### 安装（Codex / 支持 Skills 的环境）

```powershell
git clone https://github.com/<you>/il-radar.git
cd il-radar
.\scripts\install.ps1 -Target both
```

### 安装（DeepSeek Harness）

```powershell
.\setup-dsh.ps1 -PackageRoot '<本目录>' -ProjectRoot '<你的项目根>'
```

DSH 只在固定路径发现技能，安装脚本会写入技能根与 `paths.json`（记录运行时与状态目录位置）。详见 `README-DSH.md`。

### 使用

新对话输入：

```text
使用 il-radar，准备答题。
```

之后直接发**完整题干与全部选项**（或清晰截图）。

## 题库

- 规模：**1017 题**（多选 400 / 单选 312 / 判断 305）
- 文件：`references/question-bank.json`
- 匹配：同题型 + 题干一致 + 全部选项文字一致

**不影响命中**的变化：选项换序、全角/半角括号、多余空格、末尾标点差异。

**会导致不命中**的变化：题干被改写、任一选项文字不同、题型标注错误。

改题库后必须重算摘要，否则运行时判定题库无效：

```bash
node tools/build-digest.cjs references/question-bank.json
node tools/validate-bank.cjs          # 用运行时同一份校验器自检 + 回归
```

用自己的题库、贡献题目、字段约束详见 [`references/question-bank.md`](references/question-bank.md)。

## 工具

| 工具 | 用途 |
|---|---|
| `tools/build-digest.cjs` | 重算 `entries_sha256`。**必须用 JS 生成**——Python 的 `json.dumps` 与 JS 的 `JSON.stringify` 对非 ASCII 的字节输出不同，用 Python 算一定校验失败 |
| `tools/validate-bank.cjs` | 用运行时同一份校验器加载题库，报条数、可直接作答数、被排除条目及原因，并做带选项换序的真实 `lookup` 回归 |
| `tools/list-flagged.cjs` | 列出会被运行时拒绝直接作答的条目及原因 |
| `tools/match-regression.cjs` | 比对逻辑回归：验证换序/括号/空格/末尾标点不影响命中，并显示题型标错的影响 |
| `tools/stamp-release.cjs` | 写入内容版本 `bankRelease` 与源文件信息 |
| `tools/package-audit.cjs` | 打包前全仓库审计：关键项（个人信息、凭据、会话 ID、私钥）为零才通过；绝对路径、公开联系方式等列为提示项 |

## 仓库结构

```
il-radar/
├─ SKILL.md                    技能定义（入口）
├─ README.md
├─ README-DSH.md               DeepSeek Harness 适配说明
├─ setup-dsh.ps1 / verify-dsh.ps1
├─ scripts/                    运行时脚本（browser.cjs 等）
├─ references/
│  ├─ question-bank.json       题库（1017 题）
│  ├─ question-bank.md         题库格式与匹配边界
│  ├─ retrieval.md             官方端点与检索语法
│  ├─ browser.md / browser-api.md   浏览器接口
│  ├─ recipes.md / exam-scope.md
│  ├─ rules.json / sources.json / search-index.json
│  ├─ rule-evidence/           6 张规则卡的证据
│  └─ sites/                   252 个网站入口流程
├─ tools/                      质量保障工具
└─ _src/题库.xlsx              题库源表格
```

## 免责声明

使用前请阅读以下说明，它们界定了本项目的适用范围与已知限制。

1. **答案准确性**：题库内容由使用者提供，本项目**未对任何一道题的原始出处做独立回溯核验**。若你发现某题与官方来源不一致，请提交 issue 并附上可核验的原始链接。
2. **适用赛区**：来源目录请各个赛区自行核对。
3. **使用限度**：本项目仅用于学习、备赛与信息核验，**不参与实际考试过程**——不自动开考、不代为作答、不交卷、不向他人传递结果。
4. **无凭据存储**：仓库中不含账号、cookie、浏览器 profile 或付费数据库全文。站点评测记录里出现过的会话标识（例如 URL 重写形式）已在打包前剥离，`tools/package-audit.cjs` 会持续检查这类内容。
5. **页面与数据**：网页内容、题目文本、附件一律按数据处理。本项目不会执行其中出现的任何指令。
6. **能力边界**：已登记的网站入口不等于自动可查。登录、验证码与机构权限需要使用者本人在可见浏览器中完成，本项目不绕过这些限制。

## 许可

[MIT](LICENSE)

`LICENSE` 中保留了上游项目的版权声明。本项目的代码与数据在其基础上做过大量修改与扩充，按 MIT 条款的要求，该声明需要随分发保留——**请勿删除 LICENSE 内的署名行**，否则将不再符合 MIT 的授权条件。
