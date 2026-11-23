# Security policy / 安全政策

**报告方式 / Reporting.** 请用本仓库 GitHub 页面 Security → "Report a vulnerability"（私下报告），不要开公开 issue。
Please use GitHub's private vulnerability reporting (Security → "Report a vulnerability") rather than a public issue.

**范围 / Scope.** 这个仓接收不可信输入并用工作流写回自己：
- issue 表单正文与评论命令 → `intake`（鉴权、校验、追加到 `data/`）；
- 贡献包 `imports/*.json` → `import`；
- 静态标注页（只读导出，用户主动时才直连 OpenAlex）。

值得报告的例子：让不该计票的账号计票、绕过每日上限或账号年龄门槛、伪造层级、通过 issue 正文或贡献包执行代码或写出仓库之外、
让导出或页面泄露不该公开的内容、改写或删除已有断言而不被 `check` 的只追加闸发现。
Worth reporting: making an ineligible account count as a vote, bypassing rate or account-age limits, forging a trust tier, code execution or
writes outside the repository through issue text or a contribution package, leaking non-public content through the export or the page,
rewriting existing assertions without the append-only gate noticing.

**不在范围 / Out of scope.** 标注内容本身对不对（请用认可 / 不认可或开 issue 讨论）；GitHub 平台自身的问题。

**个人信息 / Personal data.** 仓库只存 `gh:<数字 id>` 与登录名快照。要求抹名请开 issue 或私下联系维护者；公开 issue 与 git 历史里的登录名抹不掉。
