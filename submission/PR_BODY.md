# 投稿 PR 描述草稿（提交到 dataelement/awesome-dsh-workbench）

> 本文件是草稿。截图与公开仓库就绪后，按下面的内容填 PR 描述。

## 工作台用途

「沙盒游戏工坊」面向**不会编程、有一点沙盒经验、想自己做游戏的青少年**：
在工作区里发现静态网页小游戏（含 `.zip` 自动解压），把它们 serve 到本机 localhost
实时预览，并在同一屏里让 AI 边看画面边改代码（改完存盘，预览自动刷新）。

## 安装来源

- 来源：**GitHub 源码**（仓库默认分支已包含构建产物 `lib/client.js`、服务端入口
  `dsh/index.js` 与 `cordis.patch.yml`，市场无需代跑构建）
- 本机 npm 未登录、无 Release，因此不采用 npm / Release 路径
- 包体积：`pnpm pack` 产出 **1.81 MiB**（规范上限 8 MiB）

## 本机验收结果

| 项目 | 结果 |
|---|---|
| 目标 Desktop 版本 | DSH Desktop **0.11.1** |
| 平台 | Windows 10.0.26200 / AMD64（win32 x64） |
| 最终安装版本 | **0.1.18** |
| 包格式静态校验 | `node scripts/check-workbench-package.mjs` 通过 |
| 本机安装 | `plugin_manager install_bundle` 安装本地 `.tgz` 成功；Harness 重启后服务端路由生效（`/_dsh/game-studio/api/*` 实测可响应） |
| 实际打开 | 左侧模式切换器的「沙盒游戏工坊」入口打开成功，业务面板可用 |
| 真实游戏回归 | 3 个真实游戏（含两层目录与 zip 包）发现、预览、静态资源全部 200 |
| 存盘自动刷新 | 改动游戏文件后 SSE 收到 `reload` 事件 |
| 鉴权/越界 | 预览缺 token → 403；`..` 越界 → 403 |
| 设计检测 | impeccable 机械检测器返回 `[]`（无缺陷） |

未验证项：仅在本机 Windows 上验证过，未在其他平台或 Desktop 版本上声明兼容。

## 需要注意的外部依赖与数据位置

- **无外部服务依赖**：只做本机静态文件服务，不访问网络、不装依赖、不跑构建。
- **数据位置**：偏好与最近目录写在 `dshHomePath('game-studio')`；`zip` 解压缓存写在
  同一数据目录的 `extracted/` 下。**不写入用户的游戏目录**。
- 卸载只移除包与入口，保留会话、项目文件与记录。

## 目录改动范围

只新增 `data/workbenches/HR2AY__dsh-game-studio.yml` 一个文件。
