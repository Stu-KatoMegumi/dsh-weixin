// src/core/store.mjs — 本地 session/ 持久化
//
// 目录结构（默认 <project>/session/）：
//   bot.json                 登录 token / baseUrl / get_updates_buf 游标
//   users.json               微信用户 -> DSH 会话映射
//   history/<userKey>.jsonl  双方对话镜像：每行 {t, role:'user'|'assistant', text}
//
// 所有写入都是原子写（临时文件 + rename），崩溃不会留半截文件。

import fs from 'node:fs'
import path from 'node:path'

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/** userKey（含 @ 等字符）转成安全的文件名片段 */
export function safeKey(userKey) {
  return userKey.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export class Store {
  /**
   * @param {string} dir session 目录（绝对路径）
   */
  constructor(dir) {
    this.dir = dir
    this.botFile = path.join(dir, 'bot.json')
    this.usersFile = path.join(dir, 'users.json')
    this.historyDir = path.join(dir, 'history')
  }

  // ── bot 状态（token/游标）──

  loadBot() {
    try {
      return JSON.parse(fs.readFileSync(this.botFile, 'utf8'))
    } catch {
      return {}
    }
  }

  saveBot(state) {
    atomicWrite(this.botFile, JSON.stringify(state, null, 2) + '\n')
  }

  // ── 用户 -> 会话映射 ──

  loadUsers() {
    try {
      return JSON.parse(fs.readFileSync(this.usersFile, 'utf8'))
    } catch {
      return {}
    }
  }

  /** 记录/刷新用户与会话的映射 */
  touchUser(userKey, sessionId) {
    const users = this.loadUsers()
    users[userKey] = {
      sessionId,
      createdAt: users[userKey]?.createdAt ?? new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    }
    atomicWrite(this.usersFile, JSON.stringify(users, null, 2) + '\n')
    return users[userKey]
  }

  // ── 双方对话镜像 ──

  historyFile(userKey) {
    return path.join(this.historyDir, safeKey(userKey) + '.jsonl')
  }

  /** 追加一条对话记录（微信用户 query 或 DSH 回复），双方都存 */
  appendHistory(userKey, role, text) {
    const file = this.historyFile(userKey)
    const line = JSON.stringify({ t: Date.now(), role, text }) + '\n'
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, line, 'utf8')
  }

  /** 读取某用户的完整对话镜像（按时间正序） */
  readHistory(userKey) {
    try {
      return fs.readFileSync(this.historyFile(userKey), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
}
