/**
 * 沙盒游戏工坊（Game Studio）服务端入口。
 *
 * 职责边界：
 * - 只读扫描用户自己选定的游戏根目录，发现其中的静态小游戏（含 index.html 的目录）。
 * - 通过本机 HTTP 路由把游戏文件按原样 serve 到 localhost，供工作台内嵌预览。
 * - 监听游戏目录的文件变化，向预览页推送“自动刷新”。
 *
 * 不写入用户的游戏目录；偏好与缓存写在 config.root 指向的 DSH 数据目录里。
 *
 * @module dsh-game-studio
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

/** Loader 条目名。 */
export const name = 'game-studio'

/** 本机接口与预览路由的路径前缀（本工作台独占）。 */
const API_PREFIX = '/_dsh/game-studio/api'
const PREVIEW_PREFIX = '/_dsh/game-studio/preview'
const EVENTS_PREFIX = '/_dsh/game-studio/events'
const PET_PREFIX = '/_dsh/game-studio/pet'

/** 本包自带的 IP 宠物素材目录（随包分发，只读）。 */
const PET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'pet')

/** 单个预览文件的大小上限：够放静态小游戏，避免把巨物读进内存。 */
const MAX_FILE_BYTES = 40 * 1024 * 1024

/** 一次扫描最多列出多少个游戏，避免超大目录把界面撑爆。 */
const MAX_GAMES = 60

/** 扫描时忽略的目录名。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '__MACOSX', '.DS_Store', '.idea', '.vscode'])

/** 往下找几层（1 = 只看子目录，2 = 再看子目录的子目录）。 */
const SCAN_DEPTH = 2

const MIME_TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
}))

function contentTypeFor(filePath) {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return MIME_TYPES.get(filePath.slice(dot).toLowerCase()) ?? 'application/octet-stream'
}

function randomId(bytes = 12) {
  const array = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(array)
  return Array.from(array, (value) => value.toString(16).padStart(2, '0')).join('')
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function titleFromHtml(html) {
  const match = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html)
  if (!match) return ''
  return match[1].replace(/\s+/g, ' ').trim()
}

/**
 * 把自动刷新客户端注入到预览的 HTML 里。
 * 只注入响应内容，不改动磁盘上的游戏文件。
 * 顺带在游戏加载后把它的画布/视口尺寸回报给宿主窗口，供预览列取默认宽度。
 */
function injectReloadClient(html, gameId, token) {
  const script = `<script>/* game-studio live reload + size probe */\n(function(){\n  try {\n    var source = new EventSource(${JSON.stringify(`${EVENTS_PREFIX}/${gameId}?token=${token}`)});\n    source.addEventListener('reload', function(){ window.location.reload(); });\n    window.__GAME_STUDIO_RELOAD__ = source;\n  } catch (error) { /* 预览照常可用，只是不会自动刷新 */ }\n  function reportSize(){\n    try {\n      var c = document.querySelector('canvas, .game, #gamebox, #root, main, body');\n      if (!c) return;\n      var w = c.scrollWidth || c.clientWidth || c.width;\n      var h = c.scrollHeight || c.clientHeight || c.height;\n      var canvas = document.querySelector('canvas');\n      if (canvas && canvas.width) w = Math.max(w, canvas.width);\n      if (canvas && canvas.height) h = Math.max(h, canvas.height);\n      if (w > 0 && h > 0 && window.parent && window.parent !== window) {\n        window.parent.postMessage({ __gameStudioSize: true, width: w, height: h, gameId: ${JSON.stringify(gameId)} }, '*');\n      }\n    } catch (e) {}\n  }\n  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reportSize);\n  else reportSize();\n  setTimeout(reportSize, 500);\n  setTimeout(reportSize, 1500);\n})();\n</script>`
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${script}</body>`)
  return html + script
}

export const inject = ['webServer', 'fs']

/**
 * 服务端入口。
 * @param ctx - Host 插件上下文。
 * @param config - 已应用默认值的配置。
 */
export function apply(ctx, config) {
  const dataRoot = config?.root ?? join(process.env.DSH_HOME ?? process.cwd(), 'game-studio')
  /** 本进程内可用的预览授权 token；Harness 重启即失效，不落盘。 */
  const token = randomId(16)
  /** 已登记的预览作用域：gameId -> 作用域记录 */
  const scopes = new Map()

  const stateFile = join(dataRoot, 'state.json')
  let state = { rootPath: '', recent: [] }
  let stateLoaded = false

  async function loadState() {
    if (stateLoaded) return state
    stateLoaded = true
    try {
      const parsed = JSON.parse(await readFile(stateFile, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        state = {
          rootPath: typeof parsed.rootPath === 'string' ? parsed.rootPath : '',
          recent: Array.isArray(parsed.recent)
            ? parsed.recent.filter((item) => typeof item === 'string').slice(0, 8)
            : []
        }
      }
    } catch {
      // 首次运行或记录损坏：用默认状态，不报错。
    }
    return state
  }

  async function saveState() {
    try {
      await mkdir(dataRoot, { recursive: true })
      await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch {
      // 记录失败不影响预览。
    }
  }

  async function readText(target) {
    const bytes = await ctx.fs.readBytes(target, undefined, 1024 * 1024)
    return Buffer.from(bytes).toString('utf8')
  }

  /** 判断一个目录是否是“游戏”：含 index.html。relativePath 为空表示就是根目录。 */
  async function describeGame(handle, id, fallbackName, relativePath) {
    let indexTarget
    try {
      indexTarget = await ctx.fs.resolve('index.html', { cwd: handle.displayPath })
    } catch {
      return null
    }
    const info = await ctx.fs.stat(indexTarget).catch(() => undefined)
    if (info?.type !== 'file') return null
    let title = ''
    try {
      title = titleFromHtml(await readText(indexTarget))
    } catch {
      title = ''
    }
    return {
      id,
      name: fallbackName,
      title: title || fallbackName,
      // 相对根目录的位置（'' 表示根目录本身就是游戏），供预览作用域重建目标用。
      relative: relativePath,
      path: handle.displayPath
    }
  }

  /** 最小 ZIP 读取：支持 STORE(0) 与 DEFLATE(8)，够解压静态小游戏。 */
  function readZipCentral(buf) {
    let eocd = -1
    const min = Math.max(0, buf.length - 65536)
    for (let i = buf.length - 22; i >= min; i -= 1) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录）')
    const count = buf.readUInt16LE(eocd + 10)
    const cdOffset = buf.readUInt32LE(eocd + 16)
    const entries = []
    let p = cdOffset
    for (let i = 0; i < count; i += 1) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录解析失败')
      const method = buf.readUInt16LE(p + 10)
      const compSize = buf.readUInt32LE(p + 20)
      const nameLen = buf.readUInt16LE(p + 28)
      const extraLen = buf.readUInt16LE(p + 30)
      const commentLen = buf.readUInt16LE(p + 32)
      const localOffset = buf.readUInt32LE(p + 42)
      const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
      entries.push({ name, method, compSize, localOffset })
      p += 46 + nameLen + extraLen + commentLen
    }
    return entries
  }

  function unzipEntry(buf, entry) {
    let p = entry.localOffset
    if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`局部头解析失败：${entry.name}`)
    const nameLen = buf.readUInt16LE(p + 26)
    const extraLen = buf.readUInt16LE(p + 28)
    const dataStart = p + 30 + nameLen + extraLen
    const data = buf.slice(dataStart, dataStart + entry.compSize)
    if (entry.method === 0) return data
    if (entry.method === 8) return inflateRawSync(data)
    throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`)
  }

  /** 把一个游戏 zip 解压到缓存目录（不写用户的游戏目录），返回解压目录句柄；失败返回 null。 */
  async function extractZipGame(rootPath, zipName) {
    const zipPath = join(rootPath, zipName)
    const folderName = zipName.replace(/\.zip$/i, '')
    const dest = join(dataRoot, 'extracted', folderName)
    try {
      const buf = readFileSync(zipPath)
      const entries = readZipCentral(buf)
      // 过滤 macOS/隐藏垃圾，并做路径穿越防护。
      const clean = entries.filter((entry) => {
        const parts = entry.name.split('/')
        if (parts.some((seg) => seg === '..' || seg === '')) return false
        if (parts.some((seg) => seg.startsWith('.'))) return false
        if (parts.some((seg) => seg === '__MACOSX')) return false
        return !entry.name.endsWith('/')
      })
      // 「zip 解压后多套一层文件夹」是最常见形态：只有一个顶层目录时剥掉它，
      // 这样 index.html 直接落在 dest 下，无需再往下猜。
      let stripped = clean
      const topDirs = new Set(clean.map((entry) => entry.name.split('/')[0]))
      if (topDirs.size === 1) {
        const [top] = topDirs
        stripped = clean.map((entry) => {
          const parts = entry.name.split('/')
          return { ...entry, name: parts.slice(1).join('/') }
        }).filter((entry) => entry.name !== '')
      }
      mkdirSync(dest, { recursive: true })
      for (const entry of stripped) {
        const out = join(dest, ...entry.name.split('/'))
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, unzipEntry(buf, entry))
      }
      return await ctx.fs.resolve(dest)
    } catch (cause) {
      console.error('[game-studio] zip 解压失败', zipName, cause)
      return null
    }
  }

  /**
   * 扫描游戏根目录：
   * - 根目录自带 index.html → 整个根目录算一个游戏；
   * - 否则往下找两层（「zip 解压后多套了一层文件夹」是最常见的形态）；
   * - 根目录下的 .zip 游戏包会被解压到缓存目录，作为游戏列出（不改动原 zip）。
   * 找不到 index.html 的目录被静默跳过，不做猜测。
   */
  async function scanGames(rawPath) {
    const handle = await ctx.fs.resolve(String(rawPath))
    const rootInfo = await ctx.fs.stat(handle)
    if (rootInfo?.type !== 'directory') throw new Error('这不是一个目录。')

    const selfGame = await describeGame(handle, 'self', '根目录游戏', '')
    if (selfGame) return { games: [selfGame], rootPath: handle.displayPath }

    const games = []
    let counter = 0
    const listEntries = async (target) => {
      try {
        return await ctx.fs.listDir(target)
      } catch {
        return []
      }
    }
    const walk = async (parent, prefix, depth) => {
      if (games.length >= MAX_GAMES) return
      const entries = await listEntries(parent)
      for (const entry of entries) {
        if (games.length >= MAX_GAMES) return
        if (entry.type !== 'directory') continue
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        const child = await ctx.fs.resolve(relative, { cwd: handle.displayPath }).catch(() => undefined)
        if (child === undefined) continue
        // id 不能含 '/'：预览路由用它的第一段做路径。真实位置放在 relative 里。
        const game = await describeGame(child, `g${counter}`, entry.name, relative)
        if (game) {
          counter += 1
          games.push(game)
          continue
        }
        if (depth < SCAN_DEPTH) await walk(child, relative, depth + 1)
      }
    }
    await walk(handle, '', 1)

    // 根目录下的 zip 游戏包：解压到缓存目录，作为游戏列出。
    const zips = (await listEntries(handle)).filter((entry) => entry.type === 'file' && entry.name.toLowerCase().endsWith('.zip'))
    for (const zip of zips) {
      if (games.length >= MAX_GAMES) break
      const extracted = await extractZipGame(handle.displayPath, zip.name)
      if (!extracted) continue
      const game = await describeGame(extracted, `g${counter}`, zip.name.replace(/\.zip$/i, ''), `__zip__/${zip.name}`)
      if (game) {
        counter += 1
        games.push({ ...game, fromZip: zip.name })
      }
    }

    games.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
    return { games, rootPath: handle.displayPath }
  }

  /** 取得（必要时建立）一个游戏的预览作用域。 */
  async function ensureScope(rootPath, game) {
    // 优先用 game.path（describeGame 已经算好：目录游戏是目录路径，zip 游戏是解压缓存路径）。
    let rootHandle
    if (typeof game.path === 'string' && game.path !== '') {
      rootHandle = await ctx.fs.resolve(game.path)
    } else {
      const rootTarget = await ctx.fs.resolve(rootPath)
      const relative = typeof game.relative === 'string' && game.relative !== '' ? game.relative : 'self'
      rootHandle = relative === 'self'
        ? rootTarget
        : await ctx.fs.resolve(relative, { cwd: rootTarget.displayPath })
    }
    const existing = scopes.get(game.id)
    // 换过文件夹后同名 id 会指向别的目录：路径不一致就必须重建，否则会串味成上一个游戏。
    if (existing !== undefined) {
      if (existing.rootPath === rootHandle.displayPath) return existing
      scopes.delete(game.id)
      await disposeScope(existing)
    }
    const scope = {
      gameId: game.id,
      rootPath: rootHandle.displayPath,
      rootTarget: rootHandle,
      watchers: new Set(),
      streams: new Set()
    }
    scopes.set(game.id, scope)
    startWatch(scope)
    return scope
  }

  /** 监听游戏目录：任何改动都让预览页刷新。 */
  function startWatch(scope) {
    const controller = new AbortController()
    let timer
    const notify = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        const payload = `event: reload\ndata: ${JSON.stringify({ gameId: scope.gameId, at: Date.now() })}\n\n`
        for (const stream of scope.streams) {
          try {
            stream.write(payload)
          } catch {
            scope.streams.delete(stream)
          }
        }
      }, 120)
    }

    let ready = false
    const pendingDisposers = []
    /** 建立后的释放函数；建立前只标记，避免监听泄漏。 */
    const dispose = async () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (!ready) {
        pendingDisposers.push(true)
        return
      }
      controller.abort()
    }
    scope.watchers.add(dispose)

    ctx.fs.watch(scope.rootTarget, (error) => {
      if (error === undefined) notify()
    }, controller.signal).then((disposeWatch) => {
      ready = true
      if (pendingDisposers.length > 0) {
        controller.abort()
        return
      }
      void disposeWatch
    }).catch(() => {
      // 平台不支持监听时预览仍可用，只是没有自动刷新。
    })
  }

  async function disposeScope(scope) {
    for (const stream of scope.streams) {
      try {
        stream.end()
      } catch {
        // 忽略关闭失败
      }
    }
    scope.streams.clear()
    for (const dispose of scope.watchers) {
      try {
        await dispose()
      } catch {
        // 忽略释放失败
      }
    }
    scope.watchers.clear()
  }

  function authorized(url) {
    return url.searchParams.get('token') === token
  }

  /** URL 路径片段需要显式解码；解不开就当作不合法。 */
  function decodeSegment(value) {
    try {
      return decodeURIComponent(value)
    } catch {
      return null
    }
  }

  /** 解析预览请求里的相对路径，并确认它没有逃出游戏目录。 */
  async function resolvePreviewFile(scope, relative) {
    let decoded
    try {
      decoded = decodeURIComponent(relative)
    } catch {
      return null
    }
    if (decoded.includes('\0')) return null
    const normalized = decoded.replace(/^\/+/, '')
    if (normalized === '') return scope.rootTarget
    const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.')
    if (segments.some((segment) => segment === '..')) return null
    let target
    try {
      target = await ctx.fs.resolve(segments.join('/'), { cwd: scope.rootPath })
    } catch {
      return null
    }
    if (!ctx.fs.contains(scope.rootTarget, target)) return null
    return target
  }

  async function serveFile(scope, relative, res, headOnly) {
    let target = await resolvePreviewFile(scope, relative)
    if (target === null) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('预览路径不合法')
      return
    }
    let info = await ctx.fs.stat(target).catch(() => undefined)
    if (info === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('找不到文件')
      return
    }
    let filePath = relative.replace(/^\/+/, '')
    if (info.type === 'directory') {
      // 目录请求回落到该目录的 index.html。
      filePath = filePath === '' ? 'index.html' : `${filePath.replace(/\/+$/, '')}/index.html`
      target = await ctx.fs.resolve(filePath, { cwd: scope.rootPath }).catch(() => undefined)
      info = target === undefined ? undefined : await ctx.fs.stat(target).catch(() => undefined)
      if (target === undefined || info === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('找不到 index.html')
        return
      }
      if (!ctx.fs.contains(scope.rootTarget, target)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('预览路径不合法')
        return
      }
    }
    if (info.type !== 'file') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('不是文件')
      return
    }
    const contentType = contentTypeFor(filePath)
    const isHtml = contentType.startsWith('text/html')
    let bytes
    try {
      bytes = await ctx.fs.readBytes(target, undefined, MAX_FILE_BYTES)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`读取失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (isHtml) {
      const html = injectReloadClient(Buffer.from(bytes).toString('utf8'), scope.gameId, token)
      const body = Buffer.from(html, 'utf8')
      res.writeHead(200, {
        'content-type': contentType,
        'cache-control': 'no-store',
        'content-length': body.length
      })
      res.end(headOnly ? undefined : body)
      return
    }
    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-store',
      'content-length': bytes.length
    })
    res.end(headOnly ? undefined : Buffer.from(bytes))
  }

  async function handleApi(req, res, url) {
    const endpoint = url.pathname.slice(API_PREFIX.length) || '/'
    // token 校验入口：客户端挂载时用它判断手上的 token（可能来自重启前）是否还有效。
    // 没带 token 时返回当前 token，带了错误 token 时返回 403。
    if (endpoint === '/ping') {
      const provided = url.searchParams.get('token')
      if (provided !== null && provided !== token) {
        json(res, 403, { error: '预览授权已失效，请重新打开工作台。', token })
        return
      }
      json(res, 200, { ok: true, token })
      return
    }
    if (!authorized(url)) {
      json(res, 403, { error: '预览授权已失效，请重新打开工作台。', token })
      return
    }
    const loaded = await loadState()
    if (endpoint === '/root' && req.method === 'GET') {
      let games = []
      let rootPath = loaded.rootPath
      let error = ''
      if (rootPath) {
        try {
          const scanned = await scanGames(rootPath)
          games = scanned.games
          rootPath = scanned.rootPath
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause)
        }
      }
      json(res, 200, { rootPath, games, recent: loaded.recent, error, token })
      return
    }
    if (endpoint === '/root' && req.method === 'POST') {
      let next = ''
      try {
        const body = JSON.parse(await readBody(req))
        next = typeof body?.path === 'string' ? body.path.trim() : ''
      } catch {
        json(res, 400, { error: '请求格式不正确。' })
        return
      }
      if (next === '') {
        json(res, 400, { error: '没有拿到目录路径。' })
        return
      }
      let scanned
      try {
        scanned = await scanGames(next)
      } catch (cause) {
        json(res, 400, { error: `这个目录打不开：${cause instanceof Error ? cause.message : String(cause)}` })
        return
      }
      loaded.rootPath = scanned.rootPath
      loaded.recent = [scanned.rootPath, ...loaded.recent.filter((item) => item !== scanned.rootPath)].slice(0, 8)
      await saveState()
      json(res, 200, { rootPath: scanned.rootPath, games: scanned.games, recent: loaded.recent, error: '', token })
      return
    }
    if (endpoint === '/games' && req.method === 'GET') {
      if (!loaded.rootPath) {
        json(res, 200, { rootPath: '', games: [], recent: loaded.recent, error: '' })
        return
      }
      try {
        const scanned = await scanGames(loaded.rootPath)
        json(res, 200, { rootPath: scanned.rootPath, games: scanned.games, recent: loaded.recent, error: '' })
      } catch (cause) {
        json(res, 200, {
          rootPath: loaded.rootPath,
          games: [],
          recent: loaded.recent,
          error: `目录暂时不可用：${cause instanceof Error ? cause.message : String(cause)}`
        })
      }
      return
    }
    if (endpoint === '/games/one' && req.method === 'GET') {
      const wanted = url.searchParams.get('gameId') ?? ''
      if (!loaded.rootPath || wanted === '') {
        json(res, 400, { error: '请先选择一个游戏。' })
        return
      }
      try {
        const scanned = await scanGames(loaded.rootPath)
        const game = scanned.games.find((item) => item.id === wanted)
        if (!game) {
          json(res, 404, { error: '这个游戏已经不在目录里了。', games: scanned.games })
          return
        }
        const scope = await ensureScope(loaded.rootPath, game)
        json(res, 200, {
          game,
          games: scanned.games,
          relative: scope.gameId,
          previewPath: `${PREVIEW_PREFIX}/${scope.gameId}/`
        })
      } catch (cause) {
        json(res, 400, { error: cause instanceof Error ? cause.message : String(cause) })
      }
      return
    }
    json(res, 404, { error: 'unknown endpoint' })
  }

  function handlePreview(req, res, url) {
    const rest = url.pathname.slice(PREVIEW_PREFIX.length).replace(/^\/+/, '')
    // 预览地址结构：/_dsh/game-studio/preview/<gameId>/<token>/<相对路径>
    // token 放在路径段里，而不是查询串 —— 这样游戏 HTML 里的相对资源（./css/…、./js/…）
    // 会自动继承同一路径前缀，子资源请求天然带上 token，不会 403。
    const segments = rest.split('/').filter((segment) => segment !== '')
    const rawGameId = segments[0] ?? ''
    const pathToken = segments[1] ?? ''
    const relative = segments.slice(2).join('/')
    const gameId = decodeSegment(rawGameId)
    const scope = gameId === null ? undefined : scopes.get(gameId)
    if (!scope) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('预览尚未准备，请在工作台里重新打开这个游戏。')
      return
    }
    if (pathToken !== token) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('预览授权已失效，请重新打开工作台。')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const headOnly = req.method === 'HEAD'
    void serveFile(scope, relative, res, headOnly).catch(() => {
      try {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('预览出错')
      } catch {
        // 响应已开始，忽略。
      }
    })
  }

  function handleEvents(req, res, url) {
    const rest = url.pathname.slice(EVENTS_PREFIX.length).replace(/^\/+/, '')
    const rawGameId = rest.split('/')[0] ?? ''
    const gameId = decodeSegment(rawGameId)
    const scope = gameId === null ? undefined : scopes.get(gameId)
    if (!scope || !authorized(url)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('预览授权已失效')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive'
    })
    res.write(': connected\n\n')
    scope.streams.add(res)
    req.on('close', () => {
      scope.streams.delete(res)
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      void handleApi(req, res, url).catch((error) => {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      })
    }
  }), 'game-studio: local api')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREVIEW_PREFIX,
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      handlePreview(req, res, url)
    }
  }), 'game-studio: local preview')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: EVENTS_PREFIX,
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      handleEvents(req, res, url)
    }
  }), 'game-studio: preview live reload')

  // IP 宠物素材：只服务本包 assets/pet 下的白名单文件，不读取用户目录。
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PET_PREFIX,
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const name = url.pathname.slice(PET_PREFIX.length).replace(/^\/+/, '')
      if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes('..')) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('不合法的素材名')
        return
      }
      const file = join(PET_DIR, name)
      let bytes
      try {
        bytes = readFileSync(file)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('找不到素材')
        return
      }
      res.writeHead(200, {
        'content-type': contentTypeFor(name),
        'cache-control': 'no-store',
        'content-length': bytes.length
      })
      res.end(req.method === 'HEAD' ? undefined : bytes)
    }
  }), 'game-studio: pet assets')

  // 服务端进程结束或工作台卸载时释放监听与预览连接；用户数据保持不动。
  ctx.effect(() => () => {
    for (const scope of scopes.values()) void disposeScope(scope)
    scopes.clear()
  }, 'game-studio: dispose preview scopes')
}
