# dsh-project-ops

[English](README.md) | 中文

`dsh-project-ops` 是可独立安装的 DeepSeek Harness Bundle。它增加三个带命名空间的模型工具，用于查找项目能力、
列出项目声明的任务，以及通过 Agent 已有的 shell 工具执行一个选定任务。

它不修改 Harness 源码，不替换 Desktop 管理的 Profile，不创建第二套任务系统，也不在后台自行运行。安装和卸载
都是普通的 Profile 插件事务。

## 兼容性

`0.1.2` 版本把运行时 peer 契约固定为：

- DeepSeek Harness 软件包 `0.1.1-rc.2`；
- `@deepseek-ai/cordis` `4.0.1`；
- Node.js `^22.19.0 || >=24.0.0`。

不同 Harness 版本必须重新通过软件包测试、构建和隔离 smoke，才能视为已验证兼容。
软件包只为避免 Profile 中的 pnpm 误报警告而把这些 peer 标为 optional；Harness Host 仍必须通过其管理的模块
fallback 提供所有列出的运行时软件包。

## 安装与卸载

推荐用一条命令安装到浏览器应用的 `web` Profile：

```sh
dsh plugin --profile web add https://github.com/Missher12/dsh-project-ops/releases/download/v0.1.2/dsh-project-ops-0.1.2.tgz
```

重启该 Profile，让 Loader 组合新增的 Bundle 行。若要从源码构建同一个 Bundle，请运行：

```sh
pnpm install --frozen-lockfile
pnpm run build
npm pack
```

然后把本地归档安装到需要暴露这些工具的 Profile：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-project-ops-0.1.2.tgz
```

只卸载本 Bundle：

```sh
dsh plugin --profile web remove dsh-project-ops
```

卸载会从该 Profile 移除依赖和 Bundle 层，但不会改写已经包含回执的历史 Session 工具结果。

## 模型工具

### `missher_project_ops_task_list`

无参数。它只读取所属 Agent Session 当前工作目录中的精确任务清单候选，并返回：

- `tasks`：ID、显示名、说明、来源、清单名、清单 SHA-256 摘要和可运行状态；
- `diagnostics`：有界的来源、代码和消息，不包含清单正文。

### `missher_project_ops_task_run`

接收：

- `taskId`：`task_list` 返回的 ID；
- `manifestDigest`：`task_list` 返回的对应小写 SHA-256 摘要。

工具会在分派前立即重新发现任务。摘要变化、任务消失、执行器不可用或执行器对 Agent 不可见时都会安全失败。
合法任务在 POSIX 上嵌套分派给 Agent 可见的 `bash`，在 Windows 上分派给 `pwsh`；因此 scope、审批、沙箱、
取消和工具结果仍由 Harness 管理。

返回内容只转发一次嵌套工具内容，并追加一份回执：

- `receiptVersion`、`taskId`、`source` 和 `manifestDigest`；
- 执行器可用时的 `executorTool`；
- `nestedCallId`、`startedAt` 和 `durationMs`；
- `outcome`：`succeeded`、`failed`、`blocked`、`aborted` 或 `unavailable`；
- 嵌套结果提供整数退出码时的 `exitCode`。

回执刻意不保存命令文本、项目路径、输出、环境变量或审批文字。它作为普通外层工具结果，按照 Harness 现有的
Session 保留规则留在历史记录中。

### `missher_project_ops_capability_search`

接收 `query` 和可选的 `limit`，范围为 1 到 10。它只排序当前调用 Agent 可见的 Harness 工具 schema，以及
当前项目发现的任务；不会搜索全局隐藏注册表，也不会改变工具 scope。

## 发现边界

Bundle 只检查以下项目根目录候选：

- `package.json`，从 `packageManager` 或唯一明确的锁文件选择 `npm`、`pnpm`、`yarn` 或 `bun`；
- `GNUmakefile`、`makefile` 或 `Makefile`，只接受下一行是 Tab recipe 的简单显式目标；
- `justfile` 或 `Justfile`，只接受无参数的简单公开 recipe。

每份清单上限为 1 MiB，最多返回 128 个按确定顺序排列的任务。Make 模式或特殊目标、带参数的 Just recipe、
畸形输入、歧义软件包管理器和未声明的任意命令都不会执行。本版本有意不支持任务参数。

## 验证边界

`node scripts/smoke.mjs` 会按精确白名单打包，扫描源码路径和疑似密钥文本，把归档安装到临时 `DSH_HOME`，
组合临时 Profile，执行安装后插件发现的临时 package 任务并检查回执，再卸载 Bundle，并用仅哈希的顶层哨兵
比较真实 `~/.dsh`。smoke 最后删除全部临时状态。`0.1.2` 已在 GitHub 托管的 macOS、Windows 和 Linux runner 上通过这套完整生命周期，
并另有本地 macOS 验收证据。Windows ARM 和其他未列出的架构仍保持未验证。
