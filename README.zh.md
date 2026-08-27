# dsh-project-ops

[English](README.md) | 中文

`dsh-project-ops` 是可独立安装的 DeepSeek Harness 执行自动驾驶 Bundle。它让 Agent 在有界范围内理解项目声明的任务，按变更文件规划受影响检查，把长任务交给 Harness 原生 Jobs，并用不含输出的回执判断验证是否完整通过。

它不修改 Harness 源码，不替换 Desktop 管理的 Profile，不接受任意命令文本，也不会重复实现 Shell、任务注册表、工作流、审查器或沙箱。工具作用域、审批、执行策略、取消、输出保留和任务持有者隔离仍由 Harness 决定。

## 兼容性

`0.2.0` 固定并验证了以下运行时契约：

- DeepSeek Harness 软件包 `0.1.1-rc.2`；
- `@deepseek-ai/cordis` `4.0.1`；
- Node.js `^22.19.0 || >=24.0.0`。

Profile 必须提供 `fs`、`tools` 和 `jobs`，并在 POSIX 上向 Agent 暴露 `bash`，或在 Windows 上暴露 `pwsh`。自动/后台执行还要求该可见 shell 定义提供 `run_in_background`，并且 Profile 已加载 Harness 常规任务控制工具。

其他 Harness 版本必须重新通过类型检查、测试、构建和隔离包生命周期 smoke 后，才能视为已验证兼容。npm 清单把运行时 peer 标记为 optional 只是为了避免 Profile 安装时的错误警告；Harness Host 仍须提供这些软件包。

## 一条命令安装或升级

安装到浏览器应用的 `web` Profile；已有旧版时运行同一命令即可升级：

```sh
dsh plugin --profile web add https://github.com/Missher12/dsh-project-ops/releases/download/v0.2.0/dsh-project-ops-0.2.0.tgz
```

然后重启该 Profile，让 Loader 重新组合 Bundle。只卸载本 Bundle：

```sh
dsh plugin --profile web remove dsh-project-ops
```

从源码构建同一个 Bundle：

```sh
pnpm install --frozen-lockfile
pnpm run build
npm pack
```

## 六个模型工具

### `missher_project_ops_task_list`

列出 Session cwd 根目录及有界声明式 package workspace 中的任务。每行包含任务身份、来源清单及 SHA-256、相对 workspace、可选包名、推断用途、依赖任务 ID 和可运行状态；不会返回脚本命令正文。

### `missher_project_ops_task_plan`

接收 1 到 256 个 workspace 相对 `changedFiles` 和一个目标：

- `verify`：测试、lint 和类型检查；
- `build`：构建任务；
- `all`：以上四类安全检查；格式化和任意 `other` 脚本不会被自动选择。

规划器会查找直接受影响的 workspace、本地反向依赖、任务依赖及匹配的根任务，返回稳定拓扑顺序、受影响 workspace、诊断、变更文件摘要和计划摘要。根目录级变更会保守地影响所有声明式 workspace。

### `missher_project_ops_task_run`

接收新鲜任务 ID、对应清单摘要和可选模式：

- `foreground`：前台等待可见 shell；为兼容旧版，它仍是默认值；
- `background`：通过 shell 原生 `run_in_background` 路径启动并返回 Harness job ID；
- `auto`：从同一后台路径启动，等待 1–10000 毫秒（默认 3000）；短任务直接返回终态回执，仍在运行的任务返回 running 回执。

Harness 无法把已在前台启动的进程提升成后台任务，因此 auto 是“先后台启动、再有界等待”。只有在执行前确认后台能力不存在时才退回前台；已经启动的 job 绝不会被重复执行。

每次分派前都会重新发现任务。清单变化、任务消失、执行器隐藏或声明不可运行都会安全失败。package workspace 任务通过 Agent 可见 shell 在其声明目录中执行。

### `missher_project_ops_task_collect`

轮询或等待 Project Ops 返回的 job。Harness JobRegistry 负责调用方持有者隔离；收集器还会在内部比较 job 的 shell 标签与重新发现的固定任务命令，匹配后才返回增量输出和新回执。

### `missher_project_ops_verification_gate`

根据 `changedFiles` 和 `goal` 重新生成受影响任务计划，再把传入的计划摘要、version-2 回执与当前清单比较。结果为：

- `passed`：全部必需任务都有新鲜的成功回执；
- `pending`：证据缺失或任务仍在运行；
- `failed`：必需任务失败、被阻止、取消或不可用；
- `stale`：计划、必需任务集合、任务元数据或清单摘要已变化。

门禁只返回任务 ID 和原因码，不重复变更路径、命令、输出、调用元数据、环境值或审批内容。

### `missher_project_ops_capability_search`

只排序当前调用 Agent 可见的 Harness 工具 schema 和当前项目任务，不搜索隐藏的全局注册表，也不会扩大工具作用域。

## 发现边界

根候选仍是 `package.json`、GNUmakefile/Makefile 变体和 Justfile 变体。package workspace 只来自 `package.json#workspaces` 或 `pnpm-workspace.yaml#packages` 下的列表。

workspace 模式只允许字面路径段、`*` 和末尾 `**`。绝对路径、父目录穿越、取反、声明中的反斜杠、不支持的 glob 语法和符号链接目录会被拒绝或跳过。固定上限为：

- 每份清单 1 MiB；
- 64 个 workspace package 目录；
- 128 个 workspace 模式；
- 遍历深度 8、检查目录 256；
- 总任务 256；
- 变更路径 256 个，每个最长 512 字符。

嵌套 package 没有声明包管理器时继承根包管理器。本地 package 依赖双方都声明同用途任务时，会生成同用途任务边。根 Make 只接受下一行含 Tab recipe 的简单显式目标；Just 只接受公开且无参数的 recipe。

## 回执边界

Version-2 回执包含任务/来源/workspace/用途身份、清单摘要、执行模式、可选执行器和 job ID、嵌套调用 ID、开始时间、耗时、结果和可选退出码。它刻意不保存命令、绝对路径、输出、环境变量、沙箱策略文字或审批文字。

回执只是证据，不是权限。验证门禁在接受回执前始终重新发现清单并重算计划。

## 验证边界

`pnpm run smoke:package` 会构建精确白名单归档，扫描源码路径和疑似密钥，在临时 `DSH_HOME` 中安装并组合临时 Profile，执行已安装插件的 workspace 任务和验证回执，再卸载 Bundle，并用仅哈希的顶层哨兵确认真实 `~/.dsh` 未变化。

GitHub CI 在托管 Linux、macOS 和 Windows runner 上运行类型检查、42 个自动测试、构建和完整生命周期。Windows ARM 与未列出的架构保持未验证。
