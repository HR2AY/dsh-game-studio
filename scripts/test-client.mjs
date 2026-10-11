#!/usr/bin/env node
/**
 * 客户端入口行为测试（不启动 Desktop、不打开浏览器）。
 *
 * 做法：
 * - 用假的 __ModuleLoader__ 在 vm 里执行 lib/client.js，验证注册协议；
 * - 用最小的 h() 替身直接调用面板的纯视图函数 PanelView，断言三种界面状态的产物；
 * - 用最小的 React 替身验证诊断错误边界能兜住渲染期异常并显示真实原文。
 *
 * 用法：node scripts/test-client.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 最小的 h()：只用来产出可读的元素树，不参与任何 React 调度。 */
function createFakeH() {
  function h(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  }
  h.Fragment = Symbol('Fragment')
  return h
}

/** 把元素树转成 HTML 片段，便于断言"界面里出现了什么"。 */
function htmlOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(htmlOf).join('')
  if (typeof node.type === 'function') return htmlOf(node.type === h.Fragment ? node.props.children : renderFakeComponent(node))
  const { children, ...attrs } = node.props ?? {}
  const tag = typeof node.type === 'string' ? node.type : 'div'
  const attributeText = Object.entries(attrs)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    .map(([name, value]) => ` ${name}="${String(value)}"`)
    .join('')
  return `<${tag}${attributeText}>${htmlOf(children)}</${tag}>`
}

/** 子组件（GameList / GameCard / EmptyState）是普通函数组件，直接调用即可。 */
function renderFakeComponent(node) {
  return node.type(node.props)
}

function stripStyles(html) {
  return html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/className=/g, 'class=')
}

const h = createFakeH()

// ---------------- 加载客户端 bundle ----------------

const clientSource = await readFile(join(packageRoot, 'lib', 'client.js'), 'utf8')
const stubReact = {
  Component: class Component {
    constructor(props) {
      this.props = props ?? {}
      this.state = {}
    }

    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
    }
  },
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  useRef: () => ({ current: null }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn()
}

let registration = null
const sandbox = {
  window: {
    location: { origin: 'http://127.0.0.1:43129' },
    __ModuleLoader__: { load(entry) { registration = entry } }
  },
  console,
  setTimeout,
  clearTimeout,
  document: { visibilityState: 'visible' },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ token: 'x'.repeat(32) }) })
}
sandbox.globalThis = sandbox
sandbox.window.window = sandbox.window

vm.runInContext(clientSource, vm.createContext(sandbox), { filename: 'lib/client.js' })

/** 在独立沙箱里加载 bundle，用于"基线字段缺失"这类场景。 */
function loadBundle(reactFace) {
  let entry = null
  const box = {
    window: {
      location: { origin: 'http://127.0.0.1:43129' },
      __ModuleLoader__: { load(value) { entry = value } }
    },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ token: 'x'.repeat(32) }) })
  }
  box.globalThis = box
  box.window.window = box.window
  vm.runInContext(clientSource, vm.createContext(box), { filename: 'lib/client.js' })
  const face = entry?.factory((specifier) => {
    if (specifier === 'react') return reactFace
    throw new Error(`不支持的模块：${specifier}`)
  })
  return { entry, face }
}

// 共享基线里若没有 React.Component，bundle 必须仍然注册成功（否则左侧入口会整体消失）。
try {
  const degraded = loadBundle({ createElement: stubReact.createElement, useState: stubReact.useState, Fragment: Symbol('Fragment') })
  check('基线没有 React.Component 时 bundle 仍能注册', degraded.entry !== null && typeof degraded.face?.apply === 'function')
  check('基线缺字段时诊断边界退化为普通类（不炸模块求值）', typeof degraded.face?.diagnosticBoundary === 'function')
  check('基线缺字段时面板纯视图仍可用', typeof degraded.face?.panelView === 'function')
} catch (error) {
  check('基线没有 React.Component 时 bundle 仍能注册', false, error.message)
}
check('客户端 bundle 通过 __ModuleLoader__.load 注册了模块', registration !== null)
check('注册的模块 id 是包名', registration?.id === 'dsh-game-studio', String(registration?.id))

const moduleFace = registration?.factory((specifier) => {
  if (specifier === 'react') return stubReact
  throw new Error(`客户端 require 了不支持的模块：${specifier}`)
})
check('factory 返回 apply 与 inject', typeof moduleFace?.apply === 'function' && Array.isArray(moduleFace?.inject))
check('inject 声明 desktopWorkbenches 与 slots', Array.isArray(moduleFace?.inject) && moduleFace.inject.includes('desktopWorkbenches') && moduleFace.inject.includes('slots'), JSON.stringify(moduleFace?.inject))
check('客户端入口暴露了 api()（token 自动维护）', typeof moduleFace?.api === 'function')

// ---------------- api() 的 token 自动刷新 ----------------
// 真实事故：GET /root 不带 token 会 403。api() 必须从 403 响应里拿到新 token 并重试一次。
{
  const calls = []
  let entry2 = null
  const box = {
    window: {
      location: { origin: 'http://127.0.0.1:43129' },
      __ModuleLoader__: { load(value) { entry2 = value } }
    },
    console,
    setTimeout,
    clearTimeout,
    document: { visibilityState: 'visible' },
    fetch: async (url) => {
      calls.push(String(url))
      if (!url.includes('token=')) {
        return { ok: false, status: 403, json: async () => ({ error: '预览授权已失效，请重新打开工作台。', token: 'fresh-token-123' }) }
      }
      if (url.includes('token=fresh-token-123')) {
        return { ok: true, status: 200, json: async () => ({ rootPath: 'C:/games', games: [], recent: [], error: '', token: 'fresh-token-123' }) }
      }
      return { ok: false, status: 403, json: async () => ({ error: 'bad', token: 'fresh-token-123' }) }
    }
  }
  box.globalThis = box
  box.window.window = box.window
  vm.runInContext(clientSource, vm.createContext(box), { filename: 'lib/client.js' })
  const face2 = entry2?.factory((specifier) => (specifier === 'react' ? stubReact : undefined))
  const result = await face2.api('/root')
  check('api() 遇到 403 会自动换 token 重试', result.rootPath === 'C:/games', JSON.stringify(result))
  check('重试请求带上了新 token', calls.some((url) => url.includes('token=fresh-token-123')), JSON.stringify(calls))
  check('首次请求不带 token 也能自愈（不抛 403）', calls[0]?.includes('token=') === false, JSON.stringify(calls))
}

// ---------------- register() 描述符 ----------------

const ctx = {
  effect(factory) {
    return factory()
  },
  get(name) {
    if (name === 'uiWorkspace') return { pickDirectory: async () => 'C:/games' }
    return undefined
  },
  desktopWorkbenches: {
    register(descriptor, Component) {
      globalThis.__registered = { descriptor, Component }
      return () => {}
    }
  }
}
globalThis.__registered = null
moduleFace.apply(ctx)
const registered = globalThis.__registered

check('apply() 调用了 desktopWorkbenches.register()', registered !== null)
const descriptor = registered?.descriptor ?? {}
check('register() 提供了 title', typeof descriptor.title === 'string' && descriptor.title.length > 0, descriptor.title)
check('register() 提供了规范 GitHub repository', /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(String(descriptor.repository)), String(descriptor.repository))
check('register() 没有填旧的 id 字段', descriptor.id === undefined)
check('customFrame 是布尔值（业务整页）', descriptor.customFrame === true, String(descriptor.customFrame))
check('没有传 Desktop 图标集之外的 icon 名', descriptor.icon === undefined, String(descriptor.icon))
const layout = descriptor.layout
check('layout 若提供则字段合法', layout === undefined || (
  (layout.businessSide === undefined || ['left', 'right'].includes(layout.businessSide))
  && (layout.businessWidth === undefined || (layout.businessWidth >= 0.25 && layout.businessWidth <= 0.7))
), JSON.stringify(layout))
check('注册了业务组件函数', typeof registered?.Component === 'function')

// ---------------- 面板纯视图：三种状态 ----------------

const panelView = moduleFace.panelView
check('客户端入口暴露了面板纯视图函数', typeof panelView === 'function')

function viewState(overrides = {}) {
  return {
    phase: 'ready',
    rootPath: '',
    games: [],
    recent: [],
    selected: null,
    previewUrl: '',
    showUrl: '',
    error: '',
    busy: false,
    frameKey: 0,
    frameLoaded: true,
    chatOpen: true,
    sessionNote: '',
    ownsCurrent: false,
    conversation: null,
    onOpenGame: () => {},
    onRefresh: () => {},
    onPickFolder: () => {},
    onUseRecent: () => {},
    onBack: () => {},
    onReloadFrame: () => {},
    onToggleChat: () => {},
    onStartSession: () => {},
    onFrameLoaded: () => {},
    ...overrides
  }
}

const games = [
  { id: 'g0', name: '小猫钓鱼', title: '小猫钓鱼 Remix', relative: '小猫钓鱼', path: 'C:/games/小猫钓鱼' },
  { id: 'g1', name: 'giraffe-race', title: '长颈鹿赛车', relative: 'giraffe-race', path: 'C:/games/giraffe-race' }
]

// 状态一：还没选文件夹
const empty = stripStyles(htmlOf(panelView(viewState())))
check('面板渲染出工作台标题', empty.includes('沙盒游戏工坊'))
check('未选文件夹时显示选择文件夹入口', empty.includes('选择游戏文件夹'))
check('未选文件夹时给出首次使用说明', empty.includes('每个游戏是一个自带 index.html 的文件夹'))
check('提供了会话区开关（公共入口不被遮挡，靠排版而非覆盖）', empty.includes('边聊边改'))
check('业务操作按钮可键盘到达（button 元素）', empty.includes('<button'))
check('样式走 gs- 前缀，未使用宿主类名', empty.includes('gs-root') && !/class="[^"]*dshWb/.test(empty))

// 状态二：发现了游戏、还没点开
const listed = stripStyles(htmlOf(panelView(viewState({ rootPath: 'C:/games', games }))))
check('有游戏时渲染卡片墙', listed.includes('gs-card') && listed.includes('小猫钓鱼 Remix'), listed.slice(0, 200))
check('卡片标题用真实中英文长度文本', listed.includes('长颈鹿赛车'))
check('卡片给出下一步动作', listed.includes('打开预览'))
check('卡片墙显示游戏数量', listed.includes('共 2 个游戏'))

// 状态三：已选中游戏 + 已关联会话
const selected = stripStyles(htmlOf(panelView(viewState({
  rootPath: 'C:/games',
  games,
  selected: games[0],
  previewUrl: '/_dsh/game-studio/preview/g0/?token=abc',
  showUrl: 'http://127.0.0.1:43129/_dsh/game-studio/preview/g0/',
  ownsCurrent: true,
  conversation: h('div', null, 'CONVERSATION_NODE')
}))))
check('已关联会话时挂载宿主会话节点', selected.includes('CONVERSATION_NODE'))
check('已关联会话时头部标注本工作台会话', selected.includes('本工作台会话'))
check('选中游戏后渲染 localhost 预览 iframe', selected.includes('<iframe') && selected.includes('127.0.0.1:43129'))
check('预览 iframe 带受限 sandbox', selected.includes('allow-scripts'))
check('预览状态条显示 localhost 地址', selected.includes('localhost 实时预览'))
check('预览状态条提供授权自愈入口', selected.includes('刷新预览授权'))

// 状态三点五：预览授权已失效（Harness 重启后 token 过期）时的界面
const stale = stripStyles(htmlOf(panelView(viewState({
  rootPath: 'C:/games',
  games,
  selected: games[0],
  previewUrl: '/_dsh/game-studio/preview/g0/?token=stale',
  showUrl: 'http://127.0.0.1:43129/_dsh/game-studio/preview/g0/',
  previewAuth: 'stale'
}))))
check('授权失效时给出明确说明与一键修复', stale.includes('预览授权已失效') && stale.includes('重新授权并打开'), stale.slice(0, 200))
check('授权失效时不再让 iframe 去撞 403', !stale.includes('<iframe'))
check('授权失效时状态条也提示可修复', stale.includes('刷新预览授权'))

// 状态四：未关联会话时给出可独立完成的引导
const noSession = stripStyles(htmlOf(panelView(viewState({ rootPath: 'C:/games', games, selected: games[1], previewUrl: '/x' }))))
check('未关联会话时给出开会话入口', noSession.includes('为这个游戏开一个工作台会话'))
check('未关联会话时给出开场描述', noSession.includes('我要改'))

// 三列布局：右下角有 IP 宠物，三态各用对应素材。
check('右下角渲染 IP 宠物且默认空闲态', noSession.includes('gs-pet') && noSession.includes('pet/idle.png'))
const petThinking = stripStyles(htmlOf(panelView(viewState({ rootPath: 'C:/games', games, selected: games[0], previewUrl: '/x', petState: 'thinking' }))))
check('宠物思考态用 thinking.gif', petThinking.includes('pet/thinking.gif'))
const petRunning = stripStyles(htmlOf(panelView(viewState({ rootPath: 'C:/games', games, selected: games[0], previewUrl: '/x', petState: 'running' }))))
check('宠物运行态用 running.gif', petRunning.includes('pet/running.gif'))

// 召出画板面板：有画布与「放入对话（PNG）」按钮。
const paintView = stripStyles(htmlOf(panelView(viewState({ rootPath: 'C:/games', games, selected: games[0], previewUrl: '/x', sidePanel: 'paint' }))))
check('召出画板面板', paintView.includes('gs-paint') && paintView.includes('<canvas'))
check('画板提供放入对话按钮（导出 PNG）', paintView.includes('放入对话（PNG）'))

// 召出麦克风面板：可编辑文本框与「放入对话」按钮。
const micView = stripStyles(htmlOf(panelView(viewState({ rootPath: 'C:/games', games, selected: games[0], previewUrl: '/x', sidePanel: 'mic', micText: '转写内容' }))))
check('召出麦克风面板', micView.includes('gs-mic') && micView.includes('转写内容'))
check('麦克风面板提供放入对话按钮', micView.includes('放入对话'))

// ---------------- 诊断错误边界 ----------------

const Boundary = moduleFace.diagnosticBoundary
check('客户端入口暴露了诊断错误边界', typeof Boundary === 'function')

/** 按 React 语义渲染：函数/类组件逐层执行，异常交给最近的错误边界。 */
function renderWithBoundary(node, nearest = null) {
  if (node === null || node === undefined || node === false) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child) => renderWithBoundary(child, nearest))
  if (typeof node.type !== 'function') return node

  const isBoundary = typeof node.type.getDerivedStateFromError === 'function'
  const boundary = isBoundary ? { type: node.type, props: node.props } : nearest

  let output
  try {
    output = node.type.prototype && typeof node.type.prototype.render === 'function'
      ? new node.type(node.props).render()
      : node.type(node.props)
  } catch (error) {
    if (boundary) {
      const fallback = new boundary.type(boundary.props ?? {})
      Object.assign(fallback.state, boundary.type.getDerivedStateFromError(error))
      return renderWithBoundary(fallback.render(), null)
    }
    throw error
  }
  return renderWithBoundary(output, boundary)
}

function CrashingChild() {
  throw new Error('模拟渲染期异常：boom')
}
function CrashingPanel() {
  return { type: 'div', props: { children: (() => { throw new Error('业务面板内部崩了：kaboom') })() } }
}

const healthyHtml = htmlOf(renderWithBoundary(stubReact.createElement(Boundary, null, stubReact.createElement(() => h('div', null, 'OK_NODE')))))
check('诊断边界正常路径不干扰渲染', healthyHtml.includes('OK_NODE') && !healthyHtml.includes('业务面板内部出错了'))

const crashHtml = stripStyles(htmlOf(renderWithBoundary(stubReact.createElement(Boundary, null, stubReact.createElement(CrashingChild)))))
check('子组件渲染抛错时诊断边界兜住并显示真实原文',
  crashHtml.includes('业务面板内部出错了') && crashHtml.includes('模拟渲染期异常：boom'),
  crashHtml.slice(0, 200))
check('诊断原文不再落入宿主通用文案', !crashHtml.includes('业务面板加载失败'))

const crashPanelHtml = stripStyles(htmlOf(renderWithBoundary(stubReact.createElement(Boundary, null, stubReact.createElement(CrashingPanel)))))
check('业务面板自身抛错时同样显示真实原文', crashPanelHtml.includes('业务面板内部出错了') && crashPanelHtml.includes('kaboom'), crashPanelHtml.slice(0, 200))

// ---------------- 宿主调用不可信：service 抛错时面板必须仍然渲染 ----------------
// 真实事故：service.ownsSession() 内部会 throw（identityForSource 解析不一致），
// 宿主调用我的组件时没有容错，整个面板会挂掉。
const PanelComponent = moduleFace.panel
check('客户端入口暴露了面板组件', typeof PanelComponent === 'function')

function renderPanel(service) {
  const element = stubReact.createElement(PanelComponent, {
    service,
    entry: { id: 'local-user/dsh-game-studio', title: '沙盒游戏工坊' },
    conversation: null
  })
  try {
    return { ok: true, html: stripStyles(htmlOf(renderWithBoundary(element))) }
  } catch (error) {
    return { ok: false, html: '', error }
  }
}

const throwingService = {
  currentSession: () => 'session-1',
  ownsSession: () => {
    throw new Error('Client package dsh-game-studio is not attributed to a market repository.')
  },
  ctx: { remote: {}, uiWorkspace: { pickDirectory: async () => null } }
}
const throwingProbe = renderPanel(throwingService)
check('service.ownsSession 抛错时面板仍能渲染',
  throwingProbe.ok && throwingProbe.html.includes('沙盒游戏工坊') && /gs-empty|gs-list/.test(throwingProbe.html),
  throwingProbe.ok ? throwingProbe.html.slice(0, 300) : `面板被异常打断：${throwingProbe.error?.message}`)
check('service 抛错时不落入宿主通用文案', !throwingProbe.html.includes('业务面板加载失败'))

const partialService = { ctx: { remote: {} } }
const partialProbe = renderPanel(partialService)
check('service 缺少方法时面板仍能渲染（可独立完成的业务不被阻断）',
  partialProbe.ok && partialProbe.html.includes('沙盒游戏工坊') && /gs-empty|gs-list/.test(partialProbe.html),
  partialProbe.ok ? partialProbe.html.slice(0, 1200) : `面板被异常打断：${partialProbe.error?.message}`)

console.log(failures === 0 ? '\n结果：客户端行为测试通过' : `\n结果：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
