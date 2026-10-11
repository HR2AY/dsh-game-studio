#!/usr/bin/env node
/**
 * 服务端行为测试（不启动 Desktop）。
 *
 * 用一个最小的 ctx.fs / ctx.webServer 替身驱动 dsh/index.js：
 * - 从一个只有 index.html 的目录里发现游戏；
 * - 预览路由返回真实文件内容，并把自动刷新脚本注入 HTML；
 * - 越界的 ../ 路径被拒绝；
 * - 缺少 token 的请求被拒绝。
 *
 * 用法：node scripts/test-server.mjs [真实游戏目录]
 * 传入目录时进入“验收模式”：对用户真实的游戏文件夹跑一遍
 * 发现 → 打开预览 → 取静态资源的真实链路。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, dirname, sep } from 'node:path'
import { stat, readdir, readFile, watch } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const packageRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** 最小 fs 替身：只实现服务端用到的那部分语义。 */
const fakeFs = {
  async resolve(path, options) {
    const base = options?.cwd ?? process.cwd()
    const full = resolve(base, path)
    return { targetKey: full, displayPath: full }
  },
  processPath(target) {
    return target.displayPath
  },
  processPathFromHostPath(hostPath) {
    return hostPath
  },
  contains(parent, child) {
    const rel = relative(parent.targetKey, child.targetKey)
    return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`))
  },
  async stat(target) {
    try {
      const info = await stat(target.targetKey)
      const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
      return { version: String(info.mtimeMs), type, size: info.size }
    } catch {
      return undefined
    }
  },
  async listDir(target) {
    const entries = await readdir(target.targetKey, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      target: { targetKey: join(target.targetKey, entry.name), displayPath: join(target.displayPath, entry.name) }
    }))
  },
  async readBytes(target, _signal, _max) {
    return new Uint8Array(await readFile(target.targetKey))
  },
  async watch(target, changed, signal) {
    const watcher = watch(target.targetKey, { recursive: true })
    watcher.on('change', () => changed())
    signal.addEventListener('abort', () => void watcher.close())
    return async () => watcher.close()
  }
}

const routes = new Map()
const fakeCtx = {
  fs: fakeFs,
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    }
  },
  effect(factory) {
    const dispose = factory()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }
}

/** 直接在进程内跑一次路由，收集状态码、响应头与响应体。 */
async function request(path, { method = 'GET', body } = {}) {
  const url = new URL(path, 'http://127.0.0.1:43129')
  let route
  for (const [prefix, candidate] of routes) {
    if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
      route = candidate
      break
    }
  }
  if (route === undefined) throw new Error(`没有匹配的路由：${url.pathname}`)
  const req = Object.assign(
    new (await import('node:stream')).Readable({ read() {} }),
    { url: url.pathname + url.search, method, headers: {} }
  )
  const chunks = []
  let status = 0
  let headers = {}
  const res = {
    writeHead(code, extra) {
      status = code
      headers = extra ?? {}
    },
    write(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
      req.push(null)
    },
    destroy() {}
  }
  if (body !== undefined) req.push(Buffer.from(body))
  req.push(null)
  route.handler(req, res)
  // 让 handler 内部的 await 链跑完。
  for (let index = 0; index < 200 && status === 0; index += 1) {
    await new Promise((resume) => setTimeout(resume, 5))
  }
  for (let index = 0; index < 40; index += 1) await new Promise((resume) => setTimeout(resume, 5))
  return { status, headers, text: Buffer.concat(chunks).toString('utf8') }
}

const tempRoot = await mkdtemp(join(tmpdir(), 'game-studio-test-'))

/** 预览 URL 现在把 token 放在路径段里：/preview/<gameId>/<token>/<相对路径>。 */
function previewUrl(previewPath, token, relative = '') {
  return `${previewPath}${token}/${relative}`
}

// 验收模式：直接对真实的游戏目录跑一遍链路。
const realRoot = process.argv[2]
if (realRoot !== undefined) {
  const { stat: statReal } = await import('node:fs/promises')
  const info = await statReal(realRoot).catch(() => undefined)
  if (info?.isDirectory() !== true) {
    console.log(`  FAIL 目录不存在或不是目录：${realRoot}`)
    process.exitCode = 1
  } else {
    const moduleReal = await import(pathToFileURL(join(packageRoot, 'dsh', 'index.js')).href)
    moduleReal.apply(fakeCtx, { root: join(tempRoot, 'data-real') })
    const tokenReal = JSON.parse((await request('/_dsh/game-studio/api/root')).text).token
    const setReal = await request(`/_dsh/game-studio/api/root?token=${tokenReal}`, {
      method: 'POST',
      body: JSON.stringify({ path: realRoot })
    })
    check('真实目录可以被登记', setReal.status === 200, `status=${setReal.status} ${setReal.text.slice(0, 200)}`)
    const realGames = JSON.parse(setReal.text).games
    check('真实目录里发现了游戏', realGames.length > 0, `games=${JSON.stringify(realGames.map((game) => game.name))}`)
    console.log(`  info 发现 ${realGames.length} 个游戏：${realGames.map((game) => `${game.name}(${game.title})`).join('、')}`)
    for (const game of realGames) {
      const opened = await request(`/_dsh/game-studio/api/games/one?token=${tokenReal}&gameId=${encodeURIComponent(game.id)}`)
      const okOpen = opened.status === 200
      let okHtml = false
      let okAssets = -1
      let refCount = 0
      if (okOpen) {
        const previewPath = JSON.parse(opened.text).previewPath
        const page = await request(previewUrl(previewPath, tokenReal))
        okHtml = page.status === 200 && page.text.includes('game-studio live reload')
        const refs = [...page.text.matchAll(/(?:src|href)="(?!https?:|\/\/|data:|#)([^"]+)"/g)]
          .map((match) => match[1])
        refCount = Math.min(refs.length, 6)
        okAssets = 0
        for (const ref of refs.slice(0, 6)) {
          const asset = await request(previewUrl(previewPath, tokenReal, ref.replace(/^\.\//, '')))
          if (asset.status === 200) okAssets += 1
        }
      }
      check(`游戏「${game.name}」能打开预览`, okOpen, `status=${opened.status}`)
      check(`游戏「${game.name}」预览 HTML 正常并注入自动刷新`, okHtml)
      check(`游戏「${game.name}」引用到的静态资源全部可访问（${okAssets}/${refCount}）`, okAssets === refCount)
      check(`游戏「${game.name}」的 id 不含斜杠（不会撞预览路由）`, !String(game.id).includes('/'), String(game.id))
    }
    await rm(tempRoot, { recursive: true, force: true })
    console.log(failures === 0 ? '\n结果：真实目录验收通过' : `\n结果：${failures} 项失败`)
    process.exit(failures === 0 ? 0 : 1)
  }
  console.log(failures === 0 ? '' : `\n结果：${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}
const gamesRoot = join(tempRoot, 'games')
const gameDir = join(gamesRoot, '小猫钓鱼')
await mkdir(join(gameDir, 'js'), { recursive: true })
await writeFile(join(gameDir, 'index.html'), '<!doctype html><html><head><title>小猫钓鱼 Remix</title></head><body><script src="js/game.js"></script></body></html>', 'utf8')
await writeFile(join(gameDir, 'js', 'game.js'), 'console.log("meow")\n', 'utf8')
await mkdir(join(gamesRoot, 'not-a-game'), { recursive: true })
await writeFile(join(gamesRoot, 'not-a-game', 'readme.txt'), 'x', 'utf8')

// 纯子目录形态的根目录（对应“几个游戏 zip 解压到同一个文件夹”的用法）。
const nestedRoot = join(tempRoot, 'nested')
await mkdir(join(nestedRoot, 'giraffe-race', 'assets'), { recursive: true })
await writeFile(join(nestedRoot, 'giraffe-race', 'index.html'), '<!doctype html><html><head><title>长颈鹿赛车</title></head><body>go</body></html>', 'utf8')
await writeFile(join(nestedRoot, 'giraffe-race', 'assets', 'style.css'), 'body{color:red}\n', 'utf8')

const dataRoot = join(tempRoot, 'data')
const module = await import(pathToFileURL(join(packageRoot, 'dsh', 'index.js')).href)
module.apply(fakeCtx, { root: dataRoot })

const unauthorized = await request('/_dsh/game-studio/api/root')
check('缺少 token 的本机接口被拒绝', unauthorized.status === 403, `status=${unauthorized.status}`)

const rootInfo = await request(`/_dsh/game-studio/api/root?token=${JSON.parse(unauthorized.text).token}`)
check('GET /root 返回 200', rootInfo.status === 200, `status=${rootInfo.status}`)
const token = JSON.parse(rootInfo.text).token
check('返回了预览 token', typeof token === 'string' && token.length >= 16)

// token 校验入口：客户端用它判断手上的 token（可能来自上一次启动）是否还有效。
const pingNoToken = await request('/_dsh/game-studio/api/ping')
check('/ping 不带 token 时返回当前 token', pingNoToken.status === 200 && JSON.parse(pingNoToken.text).token === token, `status=${pingNoToken.status}`)
const pingGood = await request(`/_dsh/game-studio/api/ping?token=${token}`)
check('/ping 带正确 token 返回 200', pingGood.status === 200, `status=${pingGood.status}`)
const pingStale = await request('/_dsh/game-studio/api/ping?token=stale-from-previous-boot')
check('/ping 带过期 token 返回 403 并给出新 token（客户端据此自愈）',
  pingStale.status === 403 && JSON.parse(pingStale.text).token === token, `status=${pingStale.status}`)

const setRoot = await request(`/_dsh/game-studio/api/root?token=${token}`, {
  method: 'POST',
  body: JSON.stringify({ path: gamesRoot })
})
check('POST /root 接受目录', setRoot.status === 200, `status=${setRoot.status} body=${setRoot.text.slice(0, 200)}`)
const scanned = JSON.parse(setRoot.text)
check('发现 1 个游戏', scanned.games.length === 1, JSON.stringify(scanned.games))
check('游戏标题来自 <title>', scanned.games[0]?.title === '小猫钓鱼 Remix', JSON.stringify(scanned.games[0]))
check('不含 index.html 的目录不算游戏', scanned.games.every((game) => game.name !== 'not-a-game'))
check('游戏 id 不含斜杠', scanned.games.every((game) => !String(game.id).includes('/')), JSON.stringify(scanned.games.map((game) => game.id)))

const firstId = scanned.games[0].id
const one = await request(`/_dsh/game-studio/api/games/one?token=${token}&gameId=${encodeURIComponent(firstId)}`)
check('打开游戏返回预览路径', one.status === 200 && /preview\/.+\/$/.test(JSON.parse(one.text).previewPath), one.text.slice(0, 200))

const previewPath = JSON.parse(one.text).previewPath
const html = await request(previewUrl(previewPath, token))
check('预览 index.html 返回 200', html.status === 200, `status=${html.status}`)
check('预览注入了自动刷新脚本', html.text.includes('game-studio live reload'), html.text.slice(0, 120))
check('预览内容仍是原游戏 HTML', html.text.includes('js/game.js'))
check('预览 content-type 是 html', String(html.headers['content-type']).startsWith('text/html'))

const js = await request(previewUrl(previewPath, token, 'js/game.js'))
check('预览子目录静态文件', js.status === 200 && js.text.includes('meow'), `status=${js.status}`)
check('js content-type 正确', String(js.headers['content-type']).startsWith('text/javascript'))

const traversal = await request(`/_dsh/game-studio/preview/${encodeURIComponent(firstId)}/${token}/..%2f..%2f..%2f..%2fetc%2fpasswd`)
check('越界路径被拒绝', traversal.status === 403 || traversal.status === 404, `status=${traversal.status}`)

const noTokenPreview = await request(`/_dsh/game-studio/preview/${firstId}/`)
check('预览缺少 token 被拒绝', noTokenPreview.status === 403, `status=${noTokenPreview.status}`)

const unknownGame = await request(`/_dsh/game-studio/api/games/one?token=${token}&gameId=nope`)
check('不存在的游戏返回 404', unknownGame.status === 404, `status=${unknownGame.status}`)

// 子目录形态：根目录没有 index.html，游戏在嵌套目录里。
const nestedSet = await request(`/_dsh/game-studio/api/root?token=${token}`, {
  method: 'POST',
  body: JSON.stringify({ path: nestedRoot })
})
const nestedGames = JSON.parse(nestedSet.text).games
check('子目录形态也能发现游戏', nestedGames.length === 1 && nestedGames[0].name === 'giraffe-race', nestedSet.text.slice(0, 200))
check('游戏记录带相对位置', nestedGames[0]?.relative === 'giraffe-race', JSON.stringify(nestedGames[0]))
const nestedOne = await request(`/_dsh/game-studio/api/games/one?token=${token}&gameId=${encodeURIComponent(nestedGames[0].id)}`)
check('子目录游戏可以打开预览', nestedOne.status === 200, nestedOne.text.slice(0, 200))
const nestedHtml = await request(previewUrl(JSON.parse(nestedOne.text).previewPath, token))
check('子目录预览返回游戏 HTML', nestedHtml.status === 200 && nestedHtml.text.includes('长颈鹿赛车'), `status=${nestedHtml.status}`)
const nestedAsset = await request(previewUrl(JSON.parse(nestedOne.text).previewPath, token, 'assets/style.css'))
check('子目录预览能取到嵌套静态资源', nestedAsset.status === 200 && nestedAsset.text.includes('color:red'), `status=${nestedAsset.status}`)

// 两层目录形态：zip 解压后多套了一层文件夹（真实用户最常见的形态）。
const deepRoot = join(tempRoot, 'deep')
await mkdir(join(deepRoot, '小猫钓鱼-clawer.io', '小猫钓鱼-remix', 'js'), { recursive: true })
await writeFile(join(deepRoot, '小猫钓鱼-clawer.io', '小猫钓鱼-remix', 'index.html'), '<!doctype html><html><head><title>小喵钓鱼</title></head><body><script src="./js/game.js"></script></body></html>', 'utf8')
await writeFile(join(deepRoot, '小猫钓鱼-clawer.io', '小猫钓鱼-remix', 'js', 'game.js'), 'console.log("deep")\n', 'utf8')
const deepSet = await request(`/_dsh/game-studio/api/root?token=${token}`, { method: 'POST', body: JSON.stringify({ path: deepRoot }) })
const deepGames = JSON.parse(deepSet.text).games
check('两层目录里的游戏也能被发现', deepGames.length === 1 && deepGames[0].title === '小喵钓鱼', deepSet.text.slice(0, 200))
check('两层目录游戏的相对位置正确', deepGames[0]?.relative === '小猫钓鱼-clawer.io/小猫钓鱼-remix', JSON.stringify(deepGames[0]?.relative))
const deepOne = await request(`/_dsh/game-studio/api/games/one?token=${token}&gameId=${encodeURIComponent(deepGames[0].id)}`)
check('两层目录游戏能打开预览（id 不含斜杠）', deepOne.status === 200, `${deepOne.status} ${deepOne.text.slice(0, 160)}`)
if (deepOne.status === 200) {
  const deepPath = JSON.parse(deepOne.text).previewPath
  const deepPage = await request(previewUrl(deepPath, token))
  check('两层目录游戏预览 HTML 正常', deepPage.status === 200 && deepPage.text.includes('game-studio live reload'), `status=${deepPage.status}`)
  const deepAsset = await request(previewUrl(deepPath, token, 'js/game.js'))
  check('两层目录游戏静态资源可访问', deepAsset.status === 200 && deepAsset.text.includes('deep'), `status=${deepAsset.status}`)
}

// 换文件夹后同名 id 必须重新绑定，不能继续服务上一个文件夹的游戏。
const switchBack = await request(`/_dsh/game-studio/api/root?token=${token}`, { method: 'POST', body: JSON.stringify({ path: nestedRoot }) })
const backGames = JSON.parse(switchBack.text).games
const backOne = await request(`/_dsh/game-studio/api/games/one?token=${token}&gameId=${encodeURIComponent(backGames[0].id)}`)
const backPage = await request(previewUrl(JSON.parse(backOne.text).previewPath, token))
check('换回原文件夹后预览指向正确的游戏（不串味）', backPage.status === 200 && backPage.text.includes('长颈鹿赛车'), `status=${backPage.status} ${backPage.text.slice(0, 80)}`)

await rm(tempRoot, { recursive: true, force: true })
console.log(failures === 0 ? '\n结果：服务端行为测试通过' : `\n结果：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
