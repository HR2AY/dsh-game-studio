#!/usr/bin/env node
/**
 * 本机包自检脚本（对应开发规范第 8 节“包与加载”的前半段）。
 *
 * 只做静态校验，不启动 Desktop、不安装、不写任何文件：
 * - package.json 的 npm / dsh 必填字段；
 * - cordis.patch.yml 的结构与 name 是否等于包名；
 * - 服务端入口与客户端入口是否存在、可解析；
 * - 客户端入口是否是 __ModuleLoader__.load 形式的已构建单文件。
 *
 * 用法：node scripts/check-workbench-package.mjs [包目录]
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(process.argv[2] ?? join(here, '..'))

const problems = []
const notes = []
const pass = (message) => notes.push(`  ok   ${message}`)
const fail = (message) => problems.push(`  FAIL ${message}`)

async function readText(relative) {
  return readFile(join(packageRoot, relative), 'utf8')
}

async function exists(relative) {
  try {
    await stat(join(packageRoot, relative))
    return true
  } catch {
    return false
  }
}

const manifest = JSON.parse(await readText('package.json'))

// ---- npm 与 dsh 字段 ----
if (typeof manifest.name !== 'string' || manifest.name.trim() === '') fail('package.json 缺少 name')
else pass(`name = ${manifest.name}`)

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(manifest.version ?? ''))) {
  fail(`version 不是完整 SemVer：${JSON.stringify(manifest.version)}`)
} else pass(`version = ${manifest.version}`)

const serverEntry = manifest.main
if (typeof serverEntry !== 'string' || serverEntry === '') fail('package.json 缺少 main')
else if (!(await exists(serverEntry))) fail(`main 指向的文件不存在：${serverEntry}`)
else pass(`main = ${serverEntry}（存在）`)

const rootExport = manifest.exports?.['.']?.default ?? manifest.exports?.['.']
if (rootExport !== `./${serverEntry}` && rootExport !== serverEntry) fail('exports["."] 必须指向与 main 相同的服务端入口')
else pass('exports["."] 指向服务端入口')

const clientExport = manifest.exports?.['./client']?.default ?? manifest.exports?.['./client']
if (typeof clientExport !== 'string') fail('exports["./client"] 缺失（声明了 dsh.client 就必须导出已构建的客户端文件）')
else if (!(await exists(clientExport))) fail(`exports["./client"] 指向的文件不存在：${clientExport}`)
else pass(`exports["./client"] = ${clientExport}（存在）`)

if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch 必须是 "./cordis.patch.yml"')
else pass('dsh.bundle.patch = ./cordis.patch.yml')

if (manifest.dsh?.client?.platform !== 'web') fail('dsh.client.platform 必须是 "web"')
else pass('dsh.client.platform = web')

const inject = manifest.dsh?.client?.inject
if (!Array.isArray(inject) || !inject.includes('dsh-desktop-workbenches')) {
  fail('dsh.client.inject 必须包含 "dsh-desktop-workbenches"')
} else pass(`dsh.client.inject = ${JSON.stringify(inject)}`)

if (Array.isArray(inject) && inject.includes(manifest.name)) fail('dsh.client.inject 不能包含自己')
for (const forbidden of ['dsh.client.inline']) {
  if (manifest.dsh?.client && Object.hasOwn(manifest.dsh.client, forbidden.replace('dsh.client.', ''))) {
    fail(`不要依赖未文档化的 dsh 字段：${forbidden}`)
  }
}

for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-client-connection']) {
  if (manifest.dependencies?.[peer]) fail(`${peer} 应写在 peerDependencies，不要写在 dependencies`)
}
pass('没有把官方 @deepseek-ai/* 包放进 dependencies')

// ---- 发布内容 ----
const files = Array.isArray(manifest.files) ? manifest.files : []
for (const required of ['dsh', 'lib', 'cordis.patch.yml']) {
  if (files.length > 0 && !files.includes(required)) fail(`files 必须包含 ${required}`)
}
if (files.length > 0) pass(`files = ${JSON.stringify(files)}`)

// ---- cordis.patch.yml ----
const patchText = await readText('cordis.patch.yml')
if (patchText.trim() === '' || patchText.split('\n').every((line) => line.trim() === '' || line.trim().startsWith('#'))) {
  fail('cordis.patch.yml 是空文件或只有注释（会导致启动失败）')
} else {
  const insertRows = patchText
    .split('\n')
    .filter((line) => /^\s*-\s*insert:\s*$/.test(line))
  const ids = [...patchText.matchAll(/^[ \t]*-[ \t]*id:[ \t]*(\S+)[ \t]*$/gm)].map((match) => match[1])
  const names = [...patchText.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((match) => match[1])
  if (insertRows.length === 0) fail('cordis.patch.yml 没有任何 insert 行')
  else pass(`cordis.patch.yml 有 ${insertRows.length} 个 insert 行`)
  if (!names.includes(manifest.name)) fail(`cordis.patch.yml 的 name 必须写 npm 包名 ${manifest.name}（不能写相对/绝对路径）`)
  else pass(`cordis.patch.yml 按包名插入：${manifest.name}`)
  if (ids.length === 0) fail('cordis.patch.yml 的 insert 行缺少 id')
  else pass(`插件条目 id = ${ids.join(', ')}`)
  const forbidden = ids.filter((id) => /^(ui-|desktop-|dsh-desktop|permission|agent-default-model)/.test(id))
  if (forbidden.length > 0) fail(`不要覆盖 Desktop 或其他插件的条目：${forbidden.join(', ')}`)
}

// ---- 服务端入口 ----
const serverUrl = pathToFileURL(join(packageRoot, serverEntry)).href
const serverModule = await import(serverUrl).catch((error) => {
  fail(`服务端入口无法导入：${error.message}`)
  return null
})
if (serverModule) {
  if (typeof serverModule.apply !== 'function') fail('服务端入口必须导出 apply 函数')
  else pass('服务端入口导出 apply')
  if (typeof serverModule.name !== 'string' || serverModule.name === '') fail('服务端入口必须导出 name')
  else pass(`服务端插件 name = ${serverModule.name}`)
  if (!Array.isArray(serverModule.inject)) fail('服务端入口必须导出 inject 数组')
  else pass(`服务端 inject = ${JSON.stringify(serverModule.inject)}`)
  if (serverModule.Config !== undefined && typeof serverModule.Config !== 'function' && typeof serverModule.Config !== 'object') {
    fail('Config 必须是 Schemastery schema')
  }
  const source = await readText(serverEntry)
  const prefixes = [...source.matchAll(/'(\/_dsh\/[^']+)'/g)].map((match) => match[1])
  if (prefixes.length === 0) fail('服务端没有声明本工作台的路径前缀')
  else pass(`本机路由前缀：${[...new Set(prefixes)].join(', ')}`)
  if (source.includes("'/api/") || source.includes('"/api/')) {
    fail('不要把本机接口挂到 /api（那是 Desktop 与 connection 的通道），请用自己的前缀')
  } else pass('没有占用 /api 路径')
}

// ---- 客户端入口 ----
const clientSource = await readText(clientExport)
if (!clientSource.includes('window.__ModuleLoader__.load(')) {
  fail('客户端入口不是 __ModuleLoader__.load 形式的已构建模块')
} else pass('客户端入口使用 window.__ModuleLoader__.load')

const loadIdMatch = /__ModuleLoader__\.load\(\s*\{\s*id:\s*'([^']+)'/.exec(clientSource)
if (!loadIdMatch) fail('无法从客户端入口读出 load({ id })')
else if (loadIdMatch[1] !== manifest.name) fail(`load id（${loadIdMatch[1]}）必须等于包名（${manifest.name}）`)
else pass(`load id = 包名 = ${loadIdMatch[1]}`)

if (!/desktopWorkbenches\.register\(/.test(clientSource)) fail('客户端没有调用 desktopWorkbenches.register()')
else pass('客户端调用 desktopWorkbenches.register()')

const registerBlock = clientSource.slice(clientSource.indexOf('desktopWorkbenches.register('))
for (const field of ['title:', 'repository:']) {
  if (!registerBlock.includes(field)) fail(`register() 缺少必填字段 ${field}`)
}
const repository = /repository:\s*'([^']+)'/.exec(clientSource)
if (!repository) fail('register() 没有可解析的 repository 字符串')
else if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(repository[1])) {
  fail(`repository 必须是规范的 GitHub 仓库 URL，当前是 ${repository[1]}`)
} else pass(`repository = ${repository[1]}`)

// 只针对 desktopWorkbenches.register() 调用：它不能带旧协议 id；slots.register 的 id 是槽位标识，合法。
if (/desktopWorkbenches\.register\(\s*\{[^}]*\bid:\s*'/.test(clientSource)) fail('新包不要在 register() 里填写旧协议 id')
else pass('register() 没有使用旧的 id 字段')

if (clientSource.includes('import ') && /^\s*import\s/m.test(clientSource)) {
  fail('客户端入口必须是单文件模块，不应含顶层 import')
} else pass('客户端入口没有顶层 import（依赖由模块加载器提供）')

const required = [...clientSource.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
const external = Array.isArray(manifest.dsh?.client?.external) ? manifest.dsh.client.external : []
const baseline = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])
const undeclared = [...new Set(required)].filter((spec) => !baseline.has(spec) && !external.includes(spec))
if (undeclared.length > 0) fail(`客户端 require 了共享基线之外且未在 dsh.client.external 声明的模块：${undeclared.join(', ')}`)
else pass(`客户端 require 的模块都在共享基线内：${[...new Set(required)].join(', ')}`)

// ---- 结果 ----
console.log(`包目录：${packageRoot}\n`)
for (const note of notes) console.log(note)
if (problems.length > 0) {
  console.log('')
  for (const problem of problems) console.log(problem)
  console.log(`\n结果：未通过（${problems.length} 项）`)
  process.exitCode = 1
} else {
  console.log('\n结果：静态校验通过')
}
