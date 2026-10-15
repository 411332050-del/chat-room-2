import { PAGE_SIZE, RateLimiter, byTime, cleanBody, parsePost, validateBody, type Post } from './rules'
import type { Handlers, Member, RoomService } from './service'

// 階段一的假後端：所有資料只存在這個瀏覽器（localStorage），
// 同一個瀏覽器的其他分頁用 BroadcastChannel 互相傳話。介面與 Supabase 版（room.ts）完全相同。

const ID_KEY = 'room2.identity'
const POSTS_KEY = 'room2.posts'
const CHANNEL = 'room2'
const BOTS: Member[] = [
  { id: 'bot-1', nickname: '小雨#104' },
  { id: 'bot-2', nickname: '阿凱#587' },
  { id: 'bot-3', nickname: '夜貓#233' },
  { id: 'bot-4', nickname: '紙飛機#860' },
]
const LINES = [
  '有人在嗎？', '剛下班，今天好累', '晚餐吃什麼好', '最近有什麼好看的劇', '週末天氣好像不錯',
  '這裡很安靜欸', '歡迎新朋友～', '大家都在做什麼', '我先去泡杯茶', '好喔，晚點聊',
]

type Wire =
  | { t: 'post'; post: Post }
  | { t: 'here'; tab: string; member: Member; reply: boolean }
  | { t: 'bye'; tab: string }

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 儲存空間滿了或被禁用：展示模式下忽略
  }
}

/** 預先放 60 則範例訊息，用來測試「最近 50 則」與「載入更早」 */
function seed(): Post[] {
  const now = Date.now()
  return Array.from({ length: 60 }, (_, i) => {
    const bot = BOTS[i % BOTS.length]
    return {
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      userId: bot.id,
      nickname: bot.nickname,
      body: LINES[i % LINES.length],
      createdAt: new Date(now - (62 - i) * 180_000).toISOString(),
    }
  })
}

/** 存在瀏覽器裡或別的分頁傳來的訊息，一樣先驗證格式（parsePost 吃資料庫的欄位名稱，所以先轉換） */
function validate(p: Post | null | undefined): Post | null {
  return parsePost({ id: p?.id, user_id: p?.userId, nickname: p?.nickname, body: p?.body, created_at: p?.createdAt })
}

export class MockRoom implements RoomService {
  private me: Member | null = null
  private channel: BroadcastChannel | null = null
  private tab = crypto.randomUUID()
  private others = new Map<string, Member>()
  private botsOnline = new Set<number>()
  private known: Map<string, string> | null = null
  private timers: number[] = []
  private limiter = new RateLimiter()

  constructor(private on: Handlers) {}

  async join(alias: string) {
    await wait(500)
    const saved = read<{ userId: string; tag: string }>(ID_KEY)
    const identity = saved?.userId && /^\d{3}$/.test(saved.tag ?? '')
      ? saved
      : { userId: crypto.randomUUID(), tag: String(Math.floor(Math.random() * 1000)).padStart(3, '0') }
    write(ID_KEY, identity)
    this.me = { id: identity.userId, nickname: `${alias}#${identity.tag}` }

    if (!(read<Post[]>(POSTS_KEY)?.length)) write(POSTS_KEY, seed())
    const all = this.posts()
    this.botsOnline = new Set([0, 1])
    this.known = null

    this.channel = new BroadcastChannel(CHANNEL)
    this.channel.onmessage = (e: MessageEvent<Wire>) => this.onWire(e.data)
    window.addEventListener('pagehide', this.onPageHide)
    this.channel.postMessage({ t: 'here', tab: this.tab, member: this.me, reply: true } satisfies Wire)

    // 事件在 join() 回傳之後才送，讓畫面先拿到「我是誰」
    setTimeout(() => {
      this.emitMembers()
      this.startTimers()
    }, 0)
    return { userId: this.me.id, nickname: this.me.nickname, history: all.slice(-PAGE_SIZE) }
  }

  async older(before: Post) {
    await wait(300)
    const older = this.posts().filter((p) => p.createdAt < before.createdAt || (p.createdAt === before.createdAt && p.id < before.id))
    return { posts: older.slice(-PAGE_SIZE), done: older.length <= PAGE_SIZE }
  }

  async send(id: string, rawBody: string) {
    const me = this.me
    if (!me) return { error: 'OFFLINE' }
    await wait(250)
    const body = cleanBody(rawBody)
    const invalid = validateBody(body)
    if (invalid) return { error: invalid }
    if (!this.limiter.tryConsume()) return { error: 'TOO_FAST' }
    const post: Post = { id, userId: me.id, nickname: me.nickname, body, createdAt: new Date().toISOString() }
    this.store(post)
    this.channel?.postMessage({ t: 'post', post } satisfies Wire)
    return { post }
  }

  leave(): void {
    this.channel?.postMessage({ t: 'bye', tab: this.tab } satisfies Wire)
    this.channel?.close()
    this.channel = null
    this.timers.forEach((t) => window.clearTimeout(t))
    this.timers = []
    this.others.clear()
    window.removeEventListener('pagehide', this.onPageHide)
  }

  // ---- 內部 ----

  private onPageHide = () => this.channel?.postMessage({ t: 'bye', tab: this.tab } satisfies Wire)

  private posts(): Post[] {
    return (read<Post[]>(POSTS_KEY) ?? []).map(validate).filter((p): p is Post => p !== null).sort(byTime)
  }

  private store(post: Post): void {
    const all = this.posts()
    if (all.some((p) => p.id === post.id)) return
    write(POSTS_KEY, [...all, post].sort(byTime).slice(-500))
  }

  private onWire(w: Wire): void {
    if (w.t === 'post') {
      const post = validate(w.post)
      if (post && post.userId !== this.me?.id) this.on.onPost(post)
    } else if (w.t === 'here') {
      if (w.member?.id && w.member.id !== this.me?.id) this.others.set(w.tab, w.member)
      if (w.reply && this.me) this.channel?.postMessage({ t: 'here', tab: this.tab, member: this.me, reply: false } satisfies Wire)
      this.emitMembers()
    } else if (w.t === 'bye') {
      this.others.delete(w.tab)
      this.emitMembers()
    }
  }

  /** 在線名單：自己、其他分頁的人、假裝在線的機器人；同一個人只算一次。並比對出誰進來、誰離開。 */
  private emitMembers(): void {
    if (!this.me) return
    const map = new Map<string, string>([[this.me.id, this.me.nickname]])
    this.others.forEach((m) => map.set(m.id, m.nickname))
    this.botsOnline.forEach((i) => map.set(BOTS[i].id, BOTS[i].nickname))
    this.on.onMembers(Array.from(map, ([id, nickname]) => ({ id, nickname })))
    if (this.known) {
      for (const [id, nickname] of map) if (!this.known.has(id) && id !== this.me.id) this.on.onNotice({ kind: 'join', nickname })
      for (const [id, nickname] of this.known) if (!map.has(id) && id !== this.me.id) this.on.onNotice({ kind: 'leave', nickname })
    }
    this.known = map
  }

  private startTimers(): void {
    const loop = (fn: () => void, min: number, max: number) => {
      const tick = () => {
        fn()
        this.timers.push(window.setTimeout(tick, min + Math.random() * (max - min)))
      }
      this.timers.push(window.setTimeout(tick, min + Math.random() * (max - min)))
    }
    // 機器人偶爾發言
    loop(() => {
      const bot = BOTS[Math.floor(Math.random() * BOTS.length)]
      const post: Post = {
        id: crypto.randomUUID(), userId: bot.id, nickname: bot.nickname,
        body: LINES[Math.floor(Math.random() * LINES.length)], createdAt: new Date().toISOString(),
      }
      this.store(post)
      this.on.onPost(post)
    }, 12_000, 25_000)
    // 機器人隨機進出，至少留 1 個
    loop(() => {
      const i = Math.floor(Math.random() * BOTS.length)
      if (this.botsOnline.has(i)) {
        if (this.botsOnline.size > 1) this.botsOnline.delete(i)
      } else {
        this.botsOnline.add(i)
      }
      this.emitMembers()
    }, 9_000, 16_000)
  }
}
