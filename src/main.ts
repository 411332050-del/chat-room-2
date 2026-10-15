import './style.css'
import { Room, type Status } from './room'
import { BODY_MAX, aliasProblem, byTime, cleanAlias, cleanBody, explain, length, type Post } from './rules'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const entry = $('entry')
const entryForm = $<HTMLFormElement>('entry-form')
const aliasInput = $<HTMLInputElement>('alias')
const aliasProblemEl = $('alias-problem')
const enterBtn = $<HTMLButtonElement>('enter-btn')
const roomEl = $('room')
const meName = $('me-name')
const onlineEl = $('online')
const statusEl = $('status')
const scroller = $('scroller')
const olderBtn = $<HTMLButtonElement>('older-btn')
const olderNote = $('older-note')
const list = $('messages')
const sendForm = $<HTMLFormElement>('send-form')
const msgInput = $<HTMLTextAreaElement>('msg')
const sendBtn = $<HTMLButtonElement>('send-btn')
const sendHint = $('send-hint')
const countEl = $('count')

interface Item extends Post {
  state: 'sent' | 'pending' | 'failed'
  mine: boolean
}

const room = new Room(import.meta.env.VITE_SUPABASE_URL ?? '', import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '', {
  onPost: (post) => upsert(post),
  onOnline: (n) => (onlineEl.textContent = `${n} 人在線`),
  onStatus: onStatus,
})

let myId = ''
let items = new Map<string, Item>()
let reachedEnd = false
let hintTimer = 0

// ---------- 進入畫面 ----------

function checkAlias(): string | null {
  const problem = aliasProblem(cleanAlias(aliasInput.value))
  aliasProblemEl.textContent = problem ?? ''
  enterBtn.disabled = problem !== null
  return problem
}
aliasInput.addEventListener('input', checkAlias)
checkAlias()

entryForm.addEventListener('submit', (e) => {
  e.preventDefault()
  if (checkAlias()) return
  void enter(cleanAlias(aliasInput.value))
})

async function enter(alias: string): Promise<void> {
  enterBtn.disabled = true
  aliasProblemEl.textContent = '正在進入…'
  try {
    const me = await room.join(alias)
    myId = me.userId
    meName.textContent = me.nickname
    items = new Map()
    me.history.forEach((p) => items.set(p.id, { ...p, state: 'sent', mine: p.userId === myId }))
    reachedEnd = me.history.length < 50
    entry.hidden = true
    roomEl.hidden = false
    statusEl.hidden = true
    render(true)
    msgInput.focus()
  } catch (error) {
    console.error('[room] 進入聊天室失敗', error)
    aliasProblemEl.textContent = '目前無法連線到聊天室，請檢查網路後再按一次「進入聊天室」'
    enterBtn.disabled = false
  }
}

$('leave-btn').addEventListener('click', () => {
  room.leave()
  roomEl.hidden = true
  entry.hidden = false
  aliasProblemEl.textContent = ''
  checkAlias()
  aliasInput.focus()
})

function onStatus(status: Status): void {
  statusEl.hidden = status === 'online'
  if (status === 'reconnecting') statusEl.textContent = '重新連線中…'
  if (status === 'lost') {
    statusEl.hidden = true
    roomEl.hidden = true
    entry.hidden = false
    aliasProblemEl.textContent = '連線中斷太久了，請再按一次「進入聊天室」重試'
    checkAlias()
  }
}

// ---------- 訊息列表 ----------

function upsert(post: Post): void {
  const prev = items.get(post.id)
  items.set(post.id, { ...post, state: 'sent', mine: post.userId === myId })
  render(prev === undefined && (post.userId === myId || nearBottom()))
}

const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80

function render(stickToBottom: boolean): void {
  const before = scroller.scrollHeight
  const sorted = [...items.values()].sort(byTime)
  list.replaceChildren()
  if (sorted.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = '還沒有人說話，來打個招呼吧'
    list.append(empty)
  }
  for (const m of sorted) list.append(renderItem(m))
  olderBtn.hidden = reachedEnd || sorted.length === 0
  olderNote.hidden = !reachedEnd || sorted.length === 0
  olderNote.textContent = '已經是最早的訊息'
  if (stickToBottom) scroller.scrollTop = scroller.scrollHeight
  else scroller.scrollTop += scroller.scrollHeight - before
}

function renderItem(m: Item): HTMLElement {
  const li = document.createElement('li')
  li.className = `msg${m.mine ? ' mine' : ''}${m.state === 'pending' ? ' pending' : ''}${m.state === 'failed' ? ' failed' : ''}`

  const meta = document.createElement('div')
  meta.className = 'msg__meta'
  const time = new Date(m.createdAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
  meta.textContent = m.mine ? time : `${m.nickname} · ${time}`

  // 一律用 textContent：訊息當純文字顯示，不會被當成 HTML 執行
  const body = document.createElement('div')
  body.className = 'msg__body'
  body.textContent = m.body

  li.append(meta, body)

  if (m.mine) {
    const state = document.createElement('div')
    state.className = 'msg__state'
    if (m.state === 'pending') state.textContent = '傳送中…'
    else if (m.state === 'sent') state.textContent = '已送出'
    else {
      state.textContent = '傳送失敗'
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'ghost'
      retry.textContent = '重試'
      retry.addEventListener('click', () => void deliver(m.id, m.body))
      state.append(retry)
    }
    li.append(state)
  }
  return li
}

olderBtn.addEventListener('click', async () => {
  const oldest = [...items.values()].sort(byTime).find((m) => m.state === 'sent')
  if (!oldest) return
  olderBtn.disabled = true
  olderBtn.textContent = '載入中…'
  try {
    const page = await room.older(oldest)
    page.posts.forEach((p) => items.set(p.id, { ...p, state: 'sent', mine: p.userId === myId }))
    reachedEnd = page.done
    render(false)
    olderBtn.textContent = '載入更早的訊息'
  } catch (error) {
    console.error('[room] 載入更早的訊息失敗', error)
    olderBtn.textContent = '載入更早的訊息失敗，按一下重試'
  } finally {
    olderBtn.disabled = false
  }
})

// ---------- 送出 ----------

function showHint(text: string): void {
  window.clearTimeout(hintTimer)
  sendHint.textContent = text
  hintTimer = window.setTimeout(() => (sendHint.textContent = ''), 4000)
}

function updateComposer(): void {
  const n = length(cleanBody(msgInput.value))
  countEl.textContent = `${n} / ${BODY_MAX}`
  countEl.classList.toggle('over', n > BODY_MAX)
  sendBtn.disabled = n === 0 || n > BODY_MAX
}
msgInput.addEventListener('input', updateComposer)
updateComposer()

msgInput.addEventListener('keydown', (e) => {
  // 電腦：Enter 送出、Shift+Enter 換行；手機（觸控）Enter 換行
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault()
    sendForm.requestSubmit()
  }
})

sendForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const body = cleanBody(msgInput.value)
  if (!body || length(body) > BODY_MAX) return
  const id = crypto.randomUUID()
  items.set(id, { id, userId: myId, nickname: meName.textContent ?? '', body, createdAt: new Date().toISOString(), state: 'pending', mine: true })
  msgInput.value = ''
  updateComposer()
  render(true)
  void deliver(id, body)
})

async function deliver(id: string, body: string): Promise<void> {
  const item = items.get(id)
  if (item) {
    item.state = 'pending'
    render(false)
  }
  const result = await room.send(id, body)
  const current = items.get(id)
  if (result.post) {
    items.set(id, { ...result.post, state: 'sent', mine: true })
  } else if (current) {
    current.state = 'failed'
    showHint(explain(result.error ?? ''))
  }
  render(true)
}

