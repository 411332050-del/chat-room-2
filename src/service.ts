import { MockRoom } from './mock'
import { Room } from './room'
import type { Post } from './rules'

export type Status = 'online' | 'reconnecting' | 'lost'

/** 在線的一個人 */
export interface Member {
  id: string
  nickname: string
}

/** 有人進來或離開（不含自己） */
export interface Notice {
  kind: 'join' | 'leave'
  nickname: string
}

export interface Handlers {
  onPost: (post: Post) => void
  onMembers: (members: Member[]) => void
  onNotice: (notice: Notice) => void
  onStatus: (status: Status) => void
}

/**
 * 畫面（main.ts）只透過這個介面跟後端說話。
 * 階段一用 MockRoom（假後端，資料存在瀏覽器），階段二用 Room（Supabase）。
 */
export interface RoomService {
  join(alias: string): Promise<{ userId: string; nickname: string; history: Post[] }>
  older(before: Post): Promise<{ posts: Post[]; done: boolean }>
  send(id: string, body: string): Promise<{ post?: Post; error?: string }>
  leave(): void
}

/** VITE_CHAT_MODE=live 才連 Supabase；沒設定時是展示模式（階段一的假後端） */
export const LIVE = import.meta.env.VITE_CHAT_MODE === 'live'

export function createRoom(handlers: Handlers): RoomService {
  if (LIVE) {
    return new Room(import.meta.env.VITE_SUPABASE_URL ?? '', import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '', handlers)
  }
  return new MockRoom(handlers)
}
