import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

/** 最小 ZIP 读取：只支持 DEFLATE（方法 8）与 STORE（方法 0），够解静态小游戏。 */
function readCentralDirectory(buf) {
  // 从尾部找 End Of Central Directory 签名 0x06054b50
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

function extractEntry(buf, entry) {
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

export function unzipEntries(buf) {
  const entries = readCentralDirectory(buf)
  const out = []
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    out.push({ name: entry.name, data: extractEntry(buf, entry) })
  }
  return out
}

// ---- 自测：解压真实游戏 zip ----
const path = process.argv[2]
const zip = readFileSync(path)
const entries = unzipEntries(zip)
console.log(`zip 条目数: ${entries.length}`)
const indexFiles = entries.filter((e) => e.name.toLowerCase().endsWith('index.html'))
console.log('index.html 数量:', indexFiles.length)
for (const f of indexFiles) console.log('  -', f.name, `(${f.data.length}B)`)
