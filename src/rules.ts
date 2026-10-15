// 前端的檢查規則。真正的把關在資料庫（supabase/schema.sql），這裡是為了讓使用者即時看到原因。

export const ALIAS_MAX = 12
export const BODY_MAX = 500
export const PAGE_SIZE = 50

const INVISIBLE = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g
const INVISIBLE_KEEP_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const length = (s: string): number => Array.from(s).length

export function cleanAlias(raw: string): string {
  return raw.replace(INVISIBLE, '').trim()
}

/** 不合格時回傳原因，合格回傳 null */
export function aliasProblem(alias: string): string | null {
  const n = length(alias)
  if (n === 0) return '請輸入代號（去掉頭尾空白後 1～12 字）'
  if (n > ALIAS_MAX) return `代號最多 ${ALIAS_MAX} 字，目前 ${n} 字`
  return null
}

export function cleanBody(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE_KEEP_NEWLINE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface Post {
  id: string
  userId: string
  nickname: string
  body: string
  createdAt: string
}

/** 收到的資料先檢查格式，不合格丟棄（回傳 null），通過後才會顯示 */
export function parsePost(row: unknown): Post | null {
  const r = (row ?? {}) as Record<string, unknown>
  const ok =
    typeof r.id === 'string' && UUID.test(r.id) &&
    typeof r.user_id === 'string' && r.user_id.length > 0 &&
    typeof r.nickname === 'string' && length(r.nickname) >= 1 && length(r.nickname) <= 20 &&
    typeof r.body === 'string' && length(r.body) >= 1 && length(r.body) <= BODY_MAX &&
    typeof r.created_at === 'string' && !Number.isNaN(Date.parse(r.created_at))
  if (!ok) {
    console.warn('[room] 丟棄格式不合的訊息')
    return null
  }
  return {
    id: r.id as string,
    userId: r.user_id as string,
    nickname: r.nickname as string,
    body: r.body as string,
    createdAt: r.created_at as string,
  }
}

export function byTime(a: Post, b: Post): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1
}

/** 資料庫回報的錯誤代碼 → 使用者看得懂的說明 */
export function explain(code: string): string {
  switch (code) {
    case 'TOO_FAST': return '發言太快了，請稍等幾秒'
    case 'TOO_LONG': return `超過 ${BODY_MAX} 字，請刪減後再送`
    case 'EMPTY': return '訊息不能是空的'
    case 'OFFLINE': return '目前離線，連線後可再試'
    default: return '送出失敗，請重試'
  }
}

/** 送出前的檢查；回傳錯誤代碼，通過回傳 null */
export function validateBody(body: string): 'EMPTY' | 'TOO_LONG' | null {
  if (body.length === 0) return 'EMPTY'
  if (length(body) > BODY_MAX) return 'TOO_LONG'
  return null
}

/** 頻率限制（假後端用，規則與資料庫一致）：10 秒最多 5 則，兩則至少間隔 0.5 秒 */
export class RateLimiter {
  private sent: number[] = []

  tryConsume(now = Date.now()): boolean {
    this.sent = this.sent.filter((t) => now - t < 10_000)
    const last = this.sent[this.sent.length - 1]
    if (this.sent.length >= 5 || (last !== undefined && now - last < 500)) return false
    this.sent.push(now)
    return true
  }
}

/** 在線名單裡別人的名稱來自對方的瀏覽器，先檢查格式才使用 */
export function isNickname(v: unknown): v is string {
  return typeof v === 'string' && length(v) >= 1 && length(v) <= 20
}

/** 「正在輸入」訊號最多每隔這麼久送一次（控制即時流量） */
export const TYPING_SEND_MS = 3000
/** 收到訊號後，這麼久沒再收到、或對方送出訊息，就不再顯示 */
export const TYPING_SHOW_MS = 5000
