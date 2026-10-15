import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import { PAGE_SIZE, byTime, parsePost, type Post } from './rules'

export type Status = 'online' | 'reconnecting' | 'lost'

export interface Handlers {
  onPost: (post: Post) => void
  onOnline: (count: number) => void
  onStatus: (status: Status) => void
}

const COLUMNS = 'id, user_id, nickname, body, created_at'
const GIVE_UP_MS = 60_000

/** 跟 Supabase 說話的一層。畫面（main.ts）只透過這裡取得資料。 */
export class Room {
  private client: SupabaseClient | null = null
  private channel: RealtimeChannel | null = null
  private lastSeen: string | null = null
  private giveUp: number | undefined
  private everOnline = false
  private closed = true

  constructor(
    private url: string,
    private key: string,
    private on: Handlers,
  ) {}

  private db(): SupabaseClient {
    if (!this.url || !this.key) throw new Error('缺少 Supabase 設定（VITE_SUPABASE_URL、VITE_SUPABASE_PUBLISHABLE_KEY）')
    this.client ??= createClient(this.url, this.key, { auth: { persistSession: true, autoRefreshToken: true } })
    return this.client
  }

  /** 以代號進入：匿名登入 → 取得「代號#編號」→ 訂閱即時訊息 → 回傳最近 50 則 */
  async join(alias: string): Promise<{ userId: string; nickname: string; history: Post[] }> {
    this.leave()
    this.closed = false
    this.everOnline = false
    const db = this.db()

    const { data: s } = await db.auth.getSession()
    let session = s.session
    if (!session) {
      const { data, error } = await db.auth.signInAnonymously()
      if (error || !data.session) throw error ?? new Error('匿名登入失敗')
      session = data.session
    }

    const { data: rows, error } = await db.rpc('join_room', { p_alias: alias })
    const me = Array.isArray(rows) ? rows[0] : null
    if (error || !me) throw error ?? new Error('進入失敗')

    await db.realtime.setAuth(session.access_token)
    await this.subscribe(me.member_id as string)
    const history = await this.fetchLatest()
    this.everOnline = true
    return { userId: me.member_id as string, nickname: me.nickname as string, history }
  }

  private subscribe(userId: string): Promise<void> {
    const db = this.db()
    return new Promise((resolve, reject) => {
      let first = true
      const timer = window.setTimeout(() => reject(new Error('連線逾時')), 12_000)
      const channel = db.channel('room', { config: { presence: { key: userId } } })
      this.channel = channel
      channel
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_posts' }, (p) => {
          const post = parsePost(p.new)
          if (post) this.deliver(post)
        })
        .on('presence', { event: 'sync' }, () => this.on.onOnline(Object.keys(channel.presenceState()).length))
        .subscribe((status) => {
          if (this.closed || this.channel !== channel) return
          if (status === 'SUBSCRIBED') {
            void channel.track({ at: Date.now() })
            window.clearTimeout(timer)
            if (first) {
              first = false
              resolve()
            } else {
              void this.catchUp()
            }
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            if (first) {
              window.clearTimeout(timer)
              reject(new Error('即時連線失敗：' + status))
            } else if (this.everOnline) {
              this.reconnecting()
            }
          }
        })
    })
  }

  private deliver(post: Post): void {
    if (!this.lastSeen || post.createdAt > this.lastSeen) this.lastSeen = post.createdAt
    this.on.onPost(post)
  }

  private reconnecting(): void {
    this.on.onStatus('reconnecting')
    if (this.giveUp === undefined) {
      this.giveUp = window.setTimeout(() => {
        this.giveUp = undefined
        this.leave()
        this.on.onStatus('lost')
      }, GIVE_UP_MS)
    }
  }

  /** 斷線重連後補抓錯過的訊息 */
  private async catchUp(): Promise<void> {
    try {
      let q = this.db().from('room_posts').select(COLUMNS).order('created_at').order('id').limit(PAGE_SIZE)
      if (this.lastSeen) q = q.gt('created_at', this.lastSeen)
      const { data, error } = await q
      if (error) throw error
      for (const row of data ?? []) {
        const post = parsePost(row)
        if (post) this.deliver(post)
      }
      window.clearTimeout(this.giveUp)
      this.giveUp = undefined
      this.on.onStatus('online')
    } catch {
      this.reconnecting()
    }
  }

  private async fetchLatest(): Promise<Post[]> {
    const { data, error } = await this.db().from('room_posts').select(COLUMNS)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(PAGE_SIZE)
    if (error) throw error
    const posts = (data ?? []).map(parsePost).filter((p): p is Post => p !== null).sort(byTime)
    posts.forEach((p) => {
      if (!this.lastSeen || p.createdAt > this.lastSeen) this.lastSeen = p.createdAt
    })
    return posts
  }

  /** 載入比 before 更早的訊息（最多 50 則） */
  async older(before: Post): Promise<{ posts: Post[]; done: boolean }> {
    const { createdAt: t, id } = before
    const { data, error } = await this.db().from('room_posts').select(COLUMNS)
      .or(`created_at.lt.${t},and(created_at.eq.${t},id.lt.${id})`)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(PAGE_SIZE + 1)
    if (error) throw error
    const rows = data ?? []
    return {
      posts: rows.slice(0, PAGE_SIZE).map(parsePost).filter((p): p is Post => p !== null).sort(byTime),
      done: rows.length <= PAGE_SIZE,
    }
  }

  /** 送出。成功回傳 { post }；失敗回傳 { error: 資料庫的錯誤代碼 } */
  async send(id: string, body: string): Promise<{ post?: Post; error?: string }> {
    if (!navigator.onLine) return { error: 'OFFLINE' }
    const { data, error } = await this.db().from('room_posts').insert({ id, body }).select(COLUMNS).single()
    if (error) {
      // 23505：這個 id 已經存在，代表上一次其實送成功了
      if (error.code === '23505') {
        const { data: existing } = await this.db().from('room_posts').select(COLUMNS).eq('id', id).maybeSingle()
        const post = parsePost(existing)
        return post ? { post } : { error: 'UNKNOWN' }
      }
      return { error: /fetch|network/i.test(error.message) ? 'OFFLINE' : error.message }
    }
    const post = parsePost(data)
    return post ? { post } : { error: 'UNKNOWN' }
  }

  leave(): void {
    this.closed = true
    window.clearTimeout(this.giveUp)
    this.giveUp = undefined
    const { channel, client } = this
    this.channel = null
    if (channel && client) {
      // 先取消在線登記，其他人的人數才會馬上更新
      const remove = () => void client.removeChannel(channel)
      void channel.untrack().then(remove, remove)
    }
  }
}
