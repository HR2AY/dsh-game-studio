# 投稿草稿（尚未提交）

本目录是向 [awesome-dsh-workbench](https://github.com/dataelement/awesome-dsh-workbench) 投稿时
要新增的条目内容，以及 PR 说明草稿。**目录本身不进入市场仓库的提交**——PR 只新增
`data/workbenches/<owner>__<repo>.yml` 一个文件。

## 待办（阻塞项，见仓库 README 的“投稿前提”一节）

1. **公开仓库尚不存在**：本机 `package.json` 的 `repository` 仍是占位地址
   `https://github.com/local-user/dsh-game-studio`。市场以仓库 `owner/repo` 为唯一身份，
   必须先创建公开仓库并把 `repository` 改指该仓库。
2. **截图缺失**：规范要求 1–5 张**在最终可安装版本上实拍**的产品画面，托管在本仓库
   （放到 `docs/images/`，推荐 16:9、宽度 ≥1280px、单张 ≤2 MiB）。没有截图不能投稿。
3. **缺少 GitHub 授权**：本机没有 `gh`、没有 `GITHUB_TOKEN`/`GH_TOKEN`，也没有配置
   credential helper，因此无法创建仓库、推送或开 PR。

## 文件

- `awesome-dsh-workbench.yml`：收录条目内容（`owner`/`repo` 与截图地址待替换）。
- `PR_BODY.md`：PR 描述草稿。

## 安装来源

本机 npm 未登录（`ENEEDAUTH`），也没有 Release，因此投稿走**源码路径**
（仓库默认分支包含可直接安装的入口与 bundle patch，市场不代跑构建）。
如果之后要改用 Release 路径，需上传 `pnpm pack` 产出的 `.tgz`，并在 YAML 里加
`tarball:` 字段。
