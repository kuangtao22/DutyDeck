# 运维 Compose 部署试点设计

日期：2026-10-14

状态：设计评审稿。用户已同意继续推进 IaC 试点，并明确选择“管理服务器已有配置，先打通发布闭环”。本文收敛产品与执行合同；尚未新增产品功能、安装依赖或操作真实服务器。

## 1. 结论与收益

建议引入部署自动化，首期以 **已有服务器上的 Docker Compose 项目** 为单位，打通“选择项目 → 预览 → 确认发布 → 查看结果 → 保留历史”。已有配置仍由用户在服务器或原有代码仓库管理。

用户不必每次重复定位目录、确认项目名、拼接命令和判断退出结果；系统记录执行目标与配置指纹，遇到断连保留不确定性，减少误发到另一套环境或重复执行的机会。

这一步属于应用部署与配置自动化。只有出现反复创建、变更、销毁云资源的需求时，才引入 OpenTofu/Terraform 的资源状态管理；多个主机重复安装软件、配置系统时，再评估 Ansible。

| 方案 | 对用户的收益 | 代价与判断 |
| --- | --- | --- |
| 保存 Shell 命令并重复执行 | 最快复用命令 | 无法独立证明目标、配置版本和执行结果；不作为本次发布闭环的底座 |
| Compose 项目部署，复用现有 SSH | 直接减少已有容器项目的重复操作 | 推荐；需要新增候选确认、独立运行记录和结果核对 |
| 一次接入 Compose、Ansible、OpenTofu | 覆盖更多基础设施场景 | 当前需求不足以支撑凭据、状态后端、资源导入等额外复杂度，暂缓 |

成功标准：用户能够选择一个已存在的 Compose 项目，看到明确的发布摘要，确认一次后执行；切页不会丢失运行，断连不会误报失败或自动重试；随后能够查看带时间与目标的历史结果。

## 2. 已有能力与真实缺口

已核查以下代码链路：

- `apps/electron/src/main/lib/server-ops/server-ops-connection-service.ts`：已有 SSH 身份、短命令、SFTP 和独立任务通道。
- `apps/electron/src/main/lib/server-ops/server-ops-docker-service.ts`：已有 owner/连接代次绑定、短期候选、审计先于动作及单飞模式。
- `apps/electron/src/main/lib/server-ops/server-ops-task-service.ts`：已有普通 Agent 会话任务，但状态主要在内存中，且权限依赖普通会话，不适合作为手工部署的产品服务。
- `apps/electron/src/main/lib/server-ops/server-ops-config-transaction.ts`、`safe-file.ts`：已有配置短事务与原子写入；新持久文件必须登记白名单，不能在事务内等待 SSH。
- `apps/electron/src/main/lib/server-ops/server-ops-audit-store.ts`：当前 schema v5；新增部署动作必须升级合同与迁移，不能伪装成现有 `exec`。
- `apps/electron/src/main/ipc.ts`：已有用户名、认证方式、凭据版本的读取绑定，可与 SSH generation 一起冻结。
- `apps/electron/src/renderer/components/server-ops/ServerOpsWorkspace.tsx`：已有 Docker、文件、终端与审计页签，可新增“部署”页签。

仓库未发现 Compose 发布实现。旧数据库脚本资产方案已由 SQL 写模式和查询历史替代，本次不恢复脚本库。现有自动化、委派及外部会话权限也不因本次试点扩展。

## 3. 首期产品范围

### 3.1 接入已有项目

用户在已连接的 SSH 主机进入“部署”，填写：显示名称、服务器目录、单个 Compose 入口文件及既有 Compose 项目名。目录必须为绝对路径；入口文件必须位于该目录内。主进程读取真实路径并固定，不依赖当前终端目录、祖先目录查找或环境默认项目名。

首次“检查项目”按明确的项目标签查询该 Docker daemon 上的现有容器；包括已停止容器，不只看正在运行的容器。至少要存在一个匹配项目的容器，且其 Compose 工作目录和配置文件标签与所选入口一致。身份缺失、配置文件不一致或同名来源冲突时，阻止纳管并说明原因。首期不负责首次创建一套新项目，也不自动扫描整台服务器。

冻结模型经 stdin 发布后，Compose 自身的配置文件标签可能变成 stdin 标识，不能仍要求它等于原文件路径。为保证下次还能识别项目，纳管后在批准模型的各服务增加 `io.dutydeck.deployment.target` 标签，值为 daemon 身份、项目名和规范来源的稳定哈希；源文件若占用该保留标签则拒绝。后续读取逐容器验证项目名和此标记，尚未重建的旧容器继续按原始来源标签验证；出现冲突或两类证据都缺失时阻断。此标签只标识来源，不携带秘密，也不作为对抗服务器管理员的认证机制。

本地仅保存项目绑定和显示信息，不复制配置正文、`.env`、凭据或完整容器 inspect 输出。

### 3.2 预览与确认

预览显示服务器、真实目录、入口文件、项目名、配置指纹、确认有效期，以及服务名、解析后的镜像 digest、端口、挂载类型/目标与风险提示。特权容器、额外 capabilities、host 网络/PID、Docker socket 挂载必须单独标出。明确标示新增服务、当前服务镜像变化以及不能确定的变化；不能把摘要称为 Terraform 式完整资源 diff。

确认卡明确说明：发布可能创建或重建容器，会拉取尚未缓存的批准镜像；不自动删除孤儿容器、数据卷或执行回滚。没有 healthcheck 的服务只能报告“运行中，未配置健康检查”。确认只批准当前候选，不能保存为永久授权。

环境变量值、命令正文、标签值、原始配置、原始 stderr、容器日志均不进入候选 DTO 或审计。警告使用固定错误码和中文解释。

### 3.3 发布与历史

用户确认后得到独立 `runId`，可以离开部署页；重新进入时读取同一运行记录。只在面板可见且存在本实例运行时订阅或刷新公开状态，不持续扫描全部项目。

历史保存目标、配置指纹、批准镜像摘要、开始时间、观察时间、状态与固定错误码。历史的“再次预览”重新读取当前配置，生成新的候选；历史记录不是可直接重放的发布票据。

结果未知时提供“核对当前状态”。核对只读取当前容器与健康状态，不能倒推上一次发布已成功。用户仍可通过已有 Docker、日志和终端工具排查。

### 3.4 支持与限制

| 项目 | 首期合同 |
| --- | --- |
| 服务器 | 已连接的 Linux SSH 主机，已有 Python 3、Docker 与通过能力探测的 Compose CLI；缺失时给出原因，不自动安装 |
| Docker 目标 | 当前服务器 `unix:///var/run/docker.sock`；不继承客户端或远端 Docker context |
| 配置 | 单个本地入口文件；支持正常 Compose 服务、网络、卷、`.env`、可展开的 `env_file` |
| 镜像 | 容器镜像发布；预览时解析 tag 为 digest，执行使用批准的 digest，缺失镜像允许拉取 |
| 执行范围 | 整个项目；不接受任意 Shell、额外 CLI 参数或自由填写子命令 |
| 首期不支持 | `build`、`profiles`、`include`、`extends`、生命周期 hooks、provider、develop/watch、多入口覆盖，以及需执行时再读文件的 configs/secrets |
| 外部网络/卷、bind mount | 摘要中明确显示；配置指纹不等于其内容快照，不保证数据回滚 |
| 发布动作 | `up` 并等待 running/healthy；不提供 `down`、删除卷、强制重建、自动回滚或无人值守发布 |
| Agent | 首期不新增部署执行工具；普通 Agent、Automation、Collaboration 的现有权限合同保持独立 |

对不支持的项目明确解释阻断字段，不尝试删字段后“尽量执行”。工作流允许用户继续通过原有终端操作，不把受限试点假装成完整 Compose 前端。

## 4. 为什么需要源配置检查和冻结模型

单纯执行两次 `docker compose config` 并比较摘要不足以保证发布正确：`include/extends` 可能在归一化输出中消失；镜像 tag 可以变化；环境文件可能改变；归一化 JSON 再次送入 Compose 时还会经过插值流程。本机 v5.1.2 的默认 JSON 已正确保留这种往返语义，不能自行再次替换 `$`；远端实际版本仍须验证。

采用两阶段处理：

1. 主进程通过既有 SFTP 有界读取入口原文，仅在内存中进行可信 YAML AST 检查。拒绝多文档、自定义标签、重复键、过量别名和上述不支持的字段；不使用正则冒充 YAML 解析器。原文不发送给 renderer、不写日志、不持久化。
2. 远端固定 helper 读取同一入口字节，核对原文 SHA-256 后，使用这些字节经 stdin 调用 Compose 解析，避免路径再次读取的竞态。显式指定真实项目目录、项目名和 `.env` 来源，清理 `DOCKER_*`、`COMPOSE_*` 及非合同内环境继承。

Compose 的展开模型、由环境文件读出的变量值和完整 stderr 保留在远端短期内存中；入口 YAML 内联的秘密可能随原文进入 Main 短期内存，不能声称所有秘密永不离开服务器。两者都不进入公开输出、持久记录或日志。对模型做有界检查后解析镜像 digest。预览候选同时绑定入口原文 hash、完整模型 hash、真实路径、daemon 身份、Compose 能力/版本和批准的服务→digest 映射。

提交时重新核对入口字节和依赖环境，使用候选中的镜像 digest 映射构造冻结模型；源配置或有效环境发生变化则拒绝并要求重新预览。tag 在预览后改变不让已批准的 digest 自动改变。

冻结模型保持 Compose 原生 JSON 转义，必须用同一 Compose CLI 做一次 `config` 语义等价验证，完整比较归一化对象，而不只比较公开摘要。含 `$`、`$$`、`${VAR}`、环境变量、命令、标签及 env_file 的真实 CLI 样例必须通过；不能证明等价时拒绝发布。冻结模型内不得残留 env_file 或未展开变量；往返检查与执行显式使用 `--env-file /dev/null`，不再读取原环境文件。执行以通过验证的同一份内存字节作为 stdin，不再从原始路径重新取模型。

源文件与 bind mount 业务数据是不同边界：冻结模型不能冻结宿主机目录内容、外部卷数据或外部服务状态。界面和文档不承诺这些资源被配置指纹保护。

### 依赖选择

仓库 `bun.lock` 已通过 Pi 运行时间接包含 `yaml@2.9.0`，但应用没有直接声明。拟将该版本声明为应用的直接运行时依赖，使用 AST 与别名预算进行输入检查；不能依赖包管理器偶然提升的传递依赖。该变更需要随具体方案审阅，并在实现时核实上游许可证、维护状态、安全信息与 Electron 打包方式。

Python helper 只使用服务器已有 Python 标准库，不安装 PyYAML，不驻留为守护进程，也不成为新的 IaC 引擎。服务器缺少能力时停在检查阶段。

## 5. 执行、权限与未知结果

### 5.1 候选与目标绑定

候选属于可信窗口 owner，有效期 5 分钟，每个 owner 最多一个待确认候选。候选绑定 hostId、connectionId、generation、用户名/认证/凭据版本指纹、目录、入口、项目名和模型指纹。修改绑定、切换主机、断连或关闭 owner 时撤销未提交候选；迟到的 prepare 结果不能恢复它。

`commit` 只接收 hostId、deploymentId、candidateId。主进程读取候选里的执行参数，不接受 renderer 重新提交路径、命令、模型或镜像映射。候选只消费一次，连续点击和并发请求不能派发第二次。

### 5.2 下发顺序

1. 复核候选、连接、认证绑定及本地同目标 reservation。
2. 完成审计 schema 准入，原子保存运行记录，并写开始审计；任何一步失败都不允许发布。
3. 用底层 `connection.startTask` 建立独立任务通道，运行固定 helper。直接复用该层的公开命令预算 65,536 字符；不经过限制为 8,192 字符且绑定 Agent 会话的 TaskService。helper 固定代码与公开参数必须有长度断言，不能在命令中放入配置正文或秘密。
4. helper 获取项目协作锁后，重新检查 Docker daemon 身份、Compose 项目名，以及每个既有容器的来源证据（稳定 `io.dutydeck.deployment.target` 标签或首轮纳管的原始 Compose 标签）。再重算指纹并验证冻结模型，确认预览后没有被同名项目替换，才发送带 runId 的 `ready`，等待有超时的放行消息。
5. Main 再次核对候选、owner、身份和运行 revision，原子标记派发后，使用已有 `writeTask` 发送一次 `go`。PTY 中只发送非秘密控制消息，不能让密码经回显进入任务输出。
6. helper 执行固定 `compose --project-directory … --env-file /dev/null -p … -f - up --no-build --pull missing --wait --wait-timeout 120`。除应用批准的参数外不拼接自由 Shell。
7. helper 输出固定结构的结果与白名单容器状态；Main 核对 taskId/连接代次/runId 后持久化终态并补结果审计。

每次 await 后重新检查必要身份；取消未执行候选也能使等待 ready 的旧提交失效。收到未知结果后不自动重发 `go`，不自动重新调用 `up`。预览所需的有界 helper 同样使用独立底层 task 通道的预算，普通 `exec` 只执行小型能力探测，不通过放宽通用命令限制适配部署。

### 5.3 状态合同

| 状态 | 能证明的事实 | 用户文案 |
| --- | --- | --- |
| `preparing` | 已登记运行，尚未放行远端发布 | 正在检查发布条件 |
| `running` | 已授权向 helper 放行，尚无可信终态 | 正在发布 |
| `succeeded` | helper 报告 `up --wait` 成功，且取得可信容器观察结果 | 发布完成；逐服务显示运行/健康情况 |
| `failed` | 收到明确拒绝或非零退出结果 | 发布未完成，部分变更可能已生效 |
| `unknown` | 放行结果、退出状态或持久结果不可确定 | 发布结果未知，请先核对当前状态 |

`failed` 另有 phase，区分“尚未执行”与“执行后失败”；不能统称已回滚。进程崩溃、SSH 中断、任务输出截断、身份变化、收到成功但结果保存失败都不能伪造确定成功。

不提供“取消即回滚”的按钮。若后续提供运行中断，必须明确只关闭通道或请求停止，不保证远端进程终止，也不撤销已生效变更。

### 5.4 多实例与锁

本地 reservation 在运维配置短事务中 fresh-read/CAS，包含 writerInstanceId、runId 和 revision。远端以固定 daemon 身份与 Compose 项目名作为锁键，不能把目录或 hostId 当作唯一锁键；同名项目即使来自不同目录也会操作同一组 Docker 资源。

Python `fcntl.flock` 非阻塞持锁覆盖重新解析、等待放行和执行；锁目录由同一远端部署账号拥有，拒绝符号链接和不安全所有权，不删除锁文件后重新创建。正常 SSH 关闭后，已放行 helper 须维持子进程监管与锁，直到子进程退出；相关 HUP/关闭路径必须实测。SIGKILL、主机崩溃或 Docker daemon 中尚在处理的动作不能由文件锁证明已停止，仍按未知结果处理。锁只协调采用本协议、使用同一远端账号的客户端；手工 CLI 和其他系统账号不受约束，不承诺全服务器排他。

不要复用旧脚本 Store 的“启动时把所有 running 改 unknown”。当前实例只写自己拥有的运行；其他 writer 的记录展示“其他实例记录，状态待核对”。现有数据根 lease 的短暂探测失败不是证明 writer 已死亡的依据。

遗留运行核对须取得同一远端协作锁，在持锁期间通过本地 CAS 增加 fence/revision，再把无可信终态的旧记录标记 unknown。只有已收到可信 helper 终态，或已实测 Compose 子进程继承锁 fd 并确认该子进程退出，才可解除本地 `reservationHeld`；仅仅重新取得一个空闲文件锁不能证明被 SIGKILL、主机崩溃或 daemon 内部处理的旧动作已经停止。无法证明时保留占用，进入明确的人工恢复路径，不允许新发布覆盖该目标。不能先“探锁”后释放、再修改本地记录。锁忙时只报告仍有协作操作，不改写原记录。旧 helper 必须先 ready 并等待 Main fresh-read 对应 revision 后才能 go，因此迟到的旧派发不能越过核对。当前状态观察单独保存观察时间，不能改写旧运行结果为 succeeded。

## 6. 持久化、预算与审计

`deployments.json` 保存部署绑定，最多 100 个；`deployment-runs.json` 保存运行摘要，最多 500 条、总文件不超过 2 MiB。运行中和仍未解除目标占用的未知记录不能为腾空间被静默淘汰；预算不足时拒绝新发布。候选保存在 Main 内存中，重启后重新预览。

运行字段包括 runId、deploymentId、hostId、writerInstanceId、revision、targetKey、daemonKey、sshPrincipalKey、connectionId/generation、credentialBindingHash、windowId、目标摘要、配置指纹、镜像 digest 摘要、status、phase、reservationHeld、startedAt、dispatchAuthorizedAt、lastObservedAt、可证明的 finishedAt、固定错误码与结果持久化告警。不保存源文件、环境值或完整输出。目标绑定编辑使用 expectedRevision，主机删除不删除已发生的运行事实。

新增文件通过固定白名单、配置事务与 `writeJsonFileAtomicSecure` 写入；损坏或不认识的 schema 必须拒绝写，不能当空历史覆盖。候选、记录、SSH、审计无法组成分布式事务：结果写失败时保留派发前记录，并显示需要核对，不能重执行来“修复历史”。

审计 schema 从 v5 升至 v6，新增 `compose-up` operation 与 `compose-project` resourceType，只允许手工可信窗口 actor。开始/结果共用 operationId/runId，resourceId 保存目标哈希；不通过 `exec` 掩盖动作类别。迁移沿用已有实例准入；保留固定 version=5 的旧 reader，不能只更改当前版本常量；同步更新共享 resourceId 校验、历史兼容测试及审计展示文案。结果先保存部署记录再补审计，结果审计失败仅告警；若补写审计，按 operationId + phase 在短事务中去重，不假定现有 append 幂等。

资源预算：入口原文 256 KiB、展开模型 1 MiB、最多 50 个服务、候选全局最多 16 个、发布并发全局最多 2 个且每目标 1 个。读取与解析设 deadline，远端捕获 stdout/stderr 必须流式限额并在超限时停止处理，不能在 `communicate()` 无界收集后才检查长度。发布阶段预算 10 分钟，`--wait` 健康等待 120 秒；超时只报告未知/未完成，不声称回滚。所有预算均由代码常量和边界测试固定。

性能影响主要发生在用户主动检查与发布时：Compose 解析、镜像元数据访问与缺失镜像下载；桌面空闲时不增加远端轮询。完整模型仅在单次远端 helper 生命周期内存在；Main 只短期持有有界入口原文和公开 DTO。

## 7. 模块边界与分步落地

不重构现有 SSH、Docker、SQL 或普通会话任务。新增独立文件，共享入口只做精确接线；当前工作树还有并行业务改动，实施时不能覆盖或混入提交。

| 步骤 | 产物与文件 | 验收依据 |
| --- | --- | --- |
| 1. 解析可行性 | 纯模型检查器、远端 helper 原型及真实 CLI 样例；`server-ops-compose-source.ts`、`server-ops-compose-command.ts` | 无 Docker daemon 的配置解析验证；确认秘密不出现在输出、冻结模型重读等价、所有不支持特性明确拒绝 |
| 2. 合同与持久记录 | `packages/shared/src/types/server-ops-deployment.ts`；Main `server-ops-deployment-store.ts` | 严格 exact-key DTO；配置 CAS、容量、损坏文件、跨 writer 和未知结果测试 |
| 3. 发布服务与审计 | Main `server-ops-deployment-service.ts`；审计 v6 与现有连接依赖注入 | 先写 BDD 失败测试，再实现候选、ready/go、身份复核、一次性提交、同目标互斥和终态保存 |
| 4. IPC 与生命周期 | `server-ops-ipc.ts`、`main/ipc.ts`、service-context；`server-ops-deployment-preload.ts`、preload index、shared index | 可信窗口检查、污染请求/响应、owner 销毁、连接更换、context 释放先于 SSH 清理 |
| 5. 界面闭环 | `ServerOpsDeploymentPanel.tsx`、独立 controller、`ServerOpsWorkspace.tsx` | 建立绑定、预览、一次确认、切页再进、历史核对；加载/空/错误态、键盘与深浅主题 |
| 6. 集成验收 | 隔离 SSH/Compose 假件与真实非生产 Compose 环境 | 断连/崩溃/并发/持久化失败；实际点击链；对真实容器的声明必须有对应实测，不能用静态渲染代替 |

最小 API 为 list/save/remove deployment、prepare、commit、cancelCandidate、list/get runs、reconcile。保存/删除是本地资产操作，删除绑定不执行 `down`；仍在运行或未核对的目标不允许删除绑定。commit 只引用一次性候选，reconcile 只做核对。部署页无须依附一个 Agent 会话。

测试场景必须包括：

- 同名项目不同目录、错误项目名、旧配置标签、路径含引号/换行、符号链接替换以及来源入口发生变化。
- `.env` 和 env_file 在预览后变化、镜像 tag 移动、原文中的 include/extends 被归一化消除、包含 `$` 的密码和命令。
- 双击确认、两个窗口同目标、两个 writer、候选过期、取消后 prepare 迟到、ready 前后断连、go 发送后无结果。
- 开始记录或审计写失败时零次 `up`；结果保存失败时不重放；历史损坏不覆盖；旧进程恢复不误改其他实例任务。
- 正常服务、健康检查失败、没有 healthcheck、部分服务已更新后失败、输出超限及进程重启后的未知状态。
- Agent/Automation/Collaboration 权限未扩大，现有 SSH task、Docker 动作、SQL 与审计查询回归通过。

验证顺序：最小相关 `bun test` → `bun run typecheck` → 因直接运行时依赖/打包变动执行 `bun run electron:build` → 隔离 UI smoke → 明确授权的非生产真实服务器验收。不自动重启正在使用的客户端，不默认访问用户生产主机。

## 8. 当前证据与未完成验证

已完成源码链路核查及 Compose 官方文档核查。本机 CLI 为 Docker Compose v5.1.2；这不代表目标服务器也具有相同能力，运行时必须逐项探测所需参数。已有运维 task/facade 定向回归上一轮为 75 pass / 0 fail；该结果只证明当时的既有能力，不能证明尚未实现的部署功能。

已完成只读配置实验：v5.1.2 下 environment、字符串/数组 command、map/list labels、普通和 raw env_file 的 JSON 往返保持深相等；删除原 env_file、改变或移除原插值环境后仍相等。手动再次替换 `$` 会破坏模型。实验使用假数据、空 Docker 配置和不存在的 daemon socket，只调用 `config`，没有访问 daemon 或镜像仓库。原始结果位于 `/private/tmp/dutydeck-compose-roundtrip-w5q2q2yj/results.json`。

本设计不宣称 Compose 试点已上线。产品代码、新增依赖准入、远端 helper、审计迁移、界面及真实服务器发布验证均属于后续实施步骤。镜像 digest 解析、真实 `up`、部署来源标签变化与服务器版本兼容仍需实施阶段的独立验证。

官方资料：

- [Compose config](https://docs.docker.com/reference/cli/docker/compose/config/)
- [Compose up](https://docs.docker.com/reference/cli/docker/compose/up/)
- [Compose ps](https://docs.docker.com/reference/cli/docker/compose/ps/)
- [项目名称优先级](https://docs.docker.com/compose/how-tos/project-name/)
- [变量插值](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)
- [include](https://docs.docker.com/reference/compose-file/include/)
- [profiles](https://docs.docker.com/compose/how-tos/profiles/)

Nowledge Mem 本机服务连接拒绝；本轮沿用已完成的定向检索失败证据，未将本稿同步到跨工具记忆。
