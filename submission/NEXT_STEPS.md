# 投稿最后一公里（需要你的 GitHub 授权）

本机核对结果：**没有可用的 GitHub 授权**——`gh` 未安装、`GITHUB_TOKEN`/`GH_TOKEN` 未设置、
git 没有配置 credential helper、profile 里也没有提供 GitHub 访问的插件。
因此仓库创建、推送和开 PR 这三步必须由你完成（或先给本机装上授权）。

下面的命令按 0 → 5 顺序执行。仓库名以 `HR2AY/dsh-game-studio` 为例。

---

## 0. 先改两处身份信息（必改，否则市场不收录）

市场以 GitHub 仓库 `owner/repo` 作为**唯一身份**，要求包的 `repository` 指回该仓库。

本机 `package.json` 里仍是占位地址 `https://github.com/local-user/dsh-game-studio`，
且带 `"private": true`。共 4 处要改：

| 文件 | 现状 | 改成 |
|---|---|---|
| `package.json` | `"url": "git+https://github.com/local-user/dsh-game-studio.git"` | `"url": "git+https://github.com/HR2AY/dsh-game-studio.git"` |
| `package.json` | `"private": true` | 删除该行（否则无法走 npm 路径） |
| `lib/client.js` | `repository: 'https://github.com/local-user/dsh-game-studio'` | `repository: 'https://github.com/HR2AY/dsh-game-studio'` |
| `LICENSE` | `Copyright (c) 2026 沙盒游戏工坊（本地构建）` | 换成你的真实署名 |

`scripts/test-client.mjs:387` 里的 `local-user/dsh-game-studio` 只是测试替身，可以不改。

改完必须重跑并**重新实机验证**（身份变了，等于换了一个工作台条目）：

```powershell
cd E:\code\games\dsh-game-studio
node scripts/check-workbench-package.mjs
node scripts/test-client.mjs
node scripts/test-server.mjs
```

> ⚠️ 身份从 `local-user/dsh-game-studio` 变成 `hr2ay/dsh-game-studio` 后，
> 本机已有的工作台条目会变成旧条目。重启 Harness 后需要在市场/工作台列表里
> 重新添加并 pin 一次（会话与项目文件不受影响）。

---

## 1. 建公开仓库并推送

网页建：<https://github.com/new> → 名称 `dsh-game-studio` → **Public** → 不要勾初始化 README。

或装好 `gh` 后：

```powershell
winget install --id GitHub.cli
gh auth login
gh repo create HR2AY/dsh-game-studio --public --source . --remote origin --push
```

手动推送：

```powershell
cd E:\code\games\dsh-game-studio
git remote add origin https://github.com/HR2AY/dsh-game-studio.git
git push -u origin main
```

---

## 2. 拍截图（必须你在已安装版本上实拍）

Agent 无法操作 Desktop 图形界面，这一步只能你来。拍到 `docs/images/`，
文件名与 `submission/awesome-dsh-workbench.yml` 里的地址一致：

- `overview.png`（封面）、`preview.png`、`paint.png`（可选 `pet.png`、`session.png`）
- PNG/JPEG/WebP，单张 ≤ 2 MiB，建议 16:9 且宽度 ≥ 1280px
- 详见 `docs/images/README.md`

```powershell
git add docs/images && git commit -m "docs: 补充市场投稿截图" && git push
```

---

## 3. 确认包校验（投稿证据）

```powershell
cd E:\code\games\dsh-game-studio
pnpm pack                       # 产出 dsh-game-studio-<version>.tgz
node -e "const s=require('fs').statSync('dsh-game-studio-<version>.tgz');console.log((s.size/1048576).toFixed(2)+' MiB')"
```

已核对：0.1.18 为 **1.81 MiB**，低于规范上限 8 MiB。

---

## 4. 建分支并只新增一个 YAML

```powershell
git clone https://github.com/dataelement/awesome-dsh-workbench.git
cd awesome-dsh-workbench
git checkout -b add-workbench-HR2AY-dsh-game-studio
# 把 submission/awesome-dsh-workbench.yml 复制成下面这个路径，其余文件一律不动
copy E:\code\games\dsh-game-studio\submission\awesome-dsh-workbench.yml data\workbenches\HR2AY__dsh-game-studio.yml
git add data/workbenches/HR2AY__dsh-game-studio.yml
git commit -m "Add workbench: 沙盒游戏工坊 (HR2AY/dsh-game-studio)"
git push -u origin add-workbench-HR2AY-dsh-game-studio
```

自查：`git diff --name-only origin/main` 必须**只有** `data/workbenches/HR2AY__dsh-game-studio.yml`。

---

## 5. 开 PR

用 `submission/PR_BODY.md` 的内容作为 PR 描述。开完把 PR URL 记下来。

- 只有拿到真实 PR URL 才能说「已提交」
- PR 合并且目录能读到条目，才能说「已上架」
- 提交后看该 PR **最新提交**的检查日志：检查未执行或跳过算「未完成」，不算通过
