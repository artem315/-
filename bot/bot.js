const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const HOST = process.env.MC_HOST || 'Artyo228.aternos.me'
const PORT = Number(process.env.MC_PORT || 40864)
const VERSION = process.env.MC_VERSION || '1.21.11'
const USERNAME = process.env.MC_USER || 'poop173'
const OWNER = process.env.MC_OWNER || '' // пусто = слушаться всех

const KEY_FILE = path.join(__dirname, '.groq_key')
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
const AI_COMMANDS = new Set(['!иди', '!следуй', '!руби', '!копай', '!стой', '!защита', '!дом', '!домой', '!спи', '!инв', '!где'])

const HELP = '!ключ <groq> !иди !следуй !руби !копай [блок] !стой !защита !дом !домой !спи !инв !дай <предмет> [кол] !где'
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew'])
const ARMOR_RANK = { leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6 }
const ARMOR_SLOT = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }

// ключ Groq живёт между переподключениями; лежит в env или в файле .groq_key
let groqKey = process.env.GROQ_API_KEY || ''
try { if (!groqKey) groqKey = fs.readFileSync(KEY_FILE, 'utf8').trim() } catch (_) {}
const aiHistory = []
let aiBusy = false

const GROQ_URL = 'https://api.groq.com/openai/v1'
// модели в порядке предпочтения; если ни одной нет, берём любую чатовую
const PREFERRED_MODELS = ['llama-3.3-70b', 'llama-4', 'gpt-oss-120b', 'kimi', 'qwen', 'gpt-oss-20b', 'llama-3.1-8b']
let groqModel = GROQ_MODEL

async function pickModel () {
  const res = await fetch(`${GROQ_URL}/models`, { headers: { Authorization: `Bearer ${groqKey}` } })
  if (!res.ok) throw Object.assign(new Error(`Groq ${res.status}`), { status: res.status })
  const ids = ((await res.json()).data || [])
    .filter((m) => m.active !== false)
    .map((m) => m.id)
    .filter((id) => !/whisper|tts|guard|embed|orpheus|playai|distil/i.test(id))
  const found = PREFERRED_MODELS.map((p) => ids.find((id) => id.includes(p))).find(Boolean) || ids[0]
  if (!found) throw new Error('нет доступных моделей')
  console.log('Groq: выбрана модель', found)
  groqModel = found
}

async function groqChat (messages) {
  return fetch(`${GROQ_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({ model: groqModel, messages, temperature: 0.6, max_tokens: 300 })
  })
}

function parseReply (content) {
  const m = content.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      const obj = JSON.parse(m[0])
      if (obj.say !== undefined || obj.cmd !== undefined) return obj
    } catch (_) {}
  }
  return { say: content.replace(/\s+/g, ' ').slice(0, 200), cmd: '' }
}

async function askGroq (username, text, state) {
  const system = 'Ты Minecraft-бот по имени ' + USERNAME + ' на ванильном сервере 1.21. Отвечай коротко по-русски (до 200 символов), дружелюбно. ' +
    'Если игрок просит что-то сделать, выбери одну команду из списка: ' + [...AI_COMMANDS].join(' ') + '. ' +
    '!копай принимает английское имя блока, например "!копай dirt". ' +
    'Ответь строго JSON без пояснений: {"say":"текст для чата","cmd":"команда или пустая строка"}. ' +
    'Состояние бота: ' + state
  aiHistory.push({ role: 'user', content: `${username}: ${text}` })
  if (aiHistory.length > 10) aiHistory.splice(0, aiHistory.length - 10)
  const messages = [{ role: 'system', content: system }, ...aiHistory]
  let res = await groqChat(messages)
  if (res.status === 404 || res.status === 400) {
    // модель убрали или переименовали: берём доступную и пробуем ещё раз
    console.log('Groq ответ:', res.status, (await res.text().catch(() => '')).slice(0, 300))
    await pickModel()
    res = await groqChat(messages)
  }
  if (!res.ok) {
    aiHistory.pop()
    console.log('Groq ответ:', res.status, (await res.text().catch(() => '')).slice(0, 300))
    throw Object.assign(new Error(`Groq ${res.status}`), { status: res.status })
  }
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content || ''
  aiHistory.push({ role: 'assistant', content })
  return parseReply(content)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function start () {
  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    version: VERSION,
    username: USERNAME,
    auth: 'offline'
  })
  bot.loadPlugin(pathfinder)

  let task = 0 // смена номера отменяет текущую задачу
  let guard = true
  let fighting = false
  let eating = false
  let armoring = false
  let home = null
  const badBlocks = new Set() // блоки, до которых не смогли добраться

  // ---------- движение ----------

  async function goTo (goal, ms = 30000) {
    let timer
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        bot.pathfinder.setGoal(null)
        reject(new Error('timeout'))
      }, ms)
    })
    try {
      await Promise.race([bot.pathfinder.goto(goal), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  function stop () {
    task++
    bot.pathfinder.setGoal(null)
  }

  // ---------- инвентарь ----------

  async function equipBestTool (block) {
    let best = null
    let bestTime = block.digTime(null, false, false, false, [], {})
    for (const item of bot.inventory.items()) {
      const t = block.digTime(item.type, false, false, false, [], {})
      if (t < bestTime) { best = item; bestTime = t }
    }
    try {
      if (best) await bot.equip(best, 'hand')
      else if (bot.heldItem) await bot.unequip('hand')
    } catch (_) {}
  }

  async function equipWeapon () {
    const weapons = bot.inventory.items().filter((i) => /_(sword|axe)$/.test(i.name))
    if (!weapons.length) return
    const rank = (i) => (i.name.endsWith('sword') ? 10 : 0) + (ARMOR_RANK[i.name.split('_')[0]] || (i.name.startsWith('wooden') ? 1 : i.name.startsWith('stone') ? 2 : 0))
    weapons.sort((a, b) => rank(b) - rank(a))
    try { await bot.equip(weapons[0], 'hand') } catch (_) {}
  }

  async function autoArmor () {
    if (armoring) return
    armoring = true
    try {
      for (const item of bot.inventory.items()) {
        const m = /^(\w+)_(helmet|chestplate|leggings|boots)$/.exec(item.name)
        if (!m || !ARMOR_RANK[m[1]]) continue
        const dest = ARMOR_SLOT[m[2]]
        const current = bot.inventory.slots[bot.getEquipmentDestSlot(dest)]
        const currentRank = current ? (ARMOR_RANK[current.name.split('_')[0]] || 0) : 0
        if (ARMOR_RANK[m[1]] > currentRank) await bot.equip(item, dest)
      }
    } catch (_) {}
    armoring = false
  }

  async function autoEat () {
    if (eating || bot.food === undefined || bot.food > 14) return
    const food = bot.inventory.items().filter((i) => bot.registry.foodsByName[i.name] && !BAD_FOOD.has(i.name))
    if (!food.length) return
    food.sort((a, b) => bot.registry.foodsByName[b.name].foodPoints - bot.registry.foodsByName[a.name].foodPoints)
    eating = true
    try {
      await bot.equip(food[0], 'hand')
      await bot.consume()
    } catch (_) {}
    eating = false
  }

  async function pickupDrops () {
    await bot.waitForTicks(8)
    for (let i = 0; i < 4; i++) {
      const drop = bot.nearestEntity((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 8)
      if (!drop) return
      try {
        await goTo(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1), 6000)
      } catch (_) { return }
    }
  }

  // ---------- задачи ----------

  async function gather (match, label) {
    const id = ++task
    let count = 0
    let fails = 0
    while (id === task) {
      while (fighting && id === task) await bot.waitForTicks(10)
      const block = bot.findBlock({
        matching: (b) => match(b.name),
        maxDistance: 48,
        useExtraInfo: (b) => !badBlocks.has(b.position.toString())
      })
      if (!block) {
        bot.chat(`${label}: больше не вижу, добыл ${count}`)
        return
      }
      try {
        await goTo(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 3))
        if (id !== task) return
        const target = bot.blockAt(block.position)
        if (!target || !match(target.name)) continue
        if (!bot.canDigBlock(target)) throw new Error('unreachable')
        await equipBestTool(target)
        await bot.dig(target)
        count++
        fails = 0
        await pickupDrops()
      } catch (err) {
        if (id !== task) return
        badBlocks.add(block.position.toString())
        console.log('gather:', err.message)
        if (++fails >= 8) {
          bot.chat(`${label}: застрял, останавливаюсь`)
          return
        }
        await bot.waitForTicks(10)
      }
    }
  }

  async function goSleep () {
    const bed = bot.findBlock({ matching: (b) => b.name.endsWith('_bed'), maxDistance: 48 })
    if (!bed) return bot.chat('Не вижу кровать')
    stop()
    try {
      await goTo(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2))
      await bot.sleep(bot.blockAt(bed.position))
      bot.chat('Сплю')
    } catch (err) {
      bot.chat('Не могу уснуть: ' + err.message)
    }
  }

  async function giveItem (username, name, amount) {
    const player = bot.players[username]?.entity
    if (!player) return bot.chat('Не вижу тебя')
    const items = bot.inventory.items().filter((i) => i.name === name || i.displayName.toLowerCase() === name.toLowerCase())
    if (!items.length) return bot.chat(`У меня нет ${name}`)
    stop()
    try {
      const p = player.position
      await goTo(new goals.GoalNear(p.x, p.y, p.z, 2))
      await bot.lookAt(player.position.offset(0, 1.6, 0))
      const total = items.reduce((s, i) => s + i.count, 0)
      await bot.toss(items[0].type, null, Math.min(amount || total, total))
      bot.chat('Держи')
    } catch (err) {
      bot.chat('Не получилось: ' + err.message)
    }
  }

  // ---------- команды ----------

  function handle (username, message, whisper = false) {
    const [cmd, ...args] = message.trim().split(/\s+/)
    const player = bot.players[username]?.entity
    switch (cmd) {
      case '!иди':
        if (!player) return bot.chat('Не вижу тебя')
        stop()
        goTo(new goals.GoalNear(player.position.x, player.position.y, player.position.z, 2)).catch(() => {})
        bot.chat('Иду')
        break
      case '!следуй':
        if (!player) return bot.chat('Не вижу тебя')
        stop()
        bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true)
        bot.chat('Следую за тобой')
        break
      case '!руби':
        bot.chat('Рублю деревья')
        gather((n) => n.endsWith('_log') || n.endsWith('_stem'), 'Дерево')
        break
      case '!копай': {
        const name = args[0] || 'stone'
        if (!bot.registry.blocksByName[name]) return bot.chat(`Не знаю блок ${name}`)
        bot.chat(`Копаю ${name}`)
        gather((n) => n === name, name)
        break
      }
      case '!стой':
        stop()
        bot.chat('Стою')
        break
      case '!защита':
        guard = !guard
        bot.chat(guard ? 'Защита включена' : 'Защита выключена')
        break
      case '!дом': {
        const p = bot.entity.position
        home = p.clone()
        bot.chat(`Дом здесь: ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`)
        break
      }
      case '!домой':
        if (!home) return bot.chat('Дом не задан, используй !дом')
        stop()
        goTo(new goals.GoalNear(home.x, home.y, home.z, 2), 120000).then(() => bot.chat('Я дома')).catch(() => bot.chat('Не дойду'))
        break
      case '!спи':
        goSleep()
        break
      case '!инв': {
        const counts = {}
        for (const i of bot.inventory.items()) counts[i.name] = (counts[i.name] || 0) + i.count
        const text = Object.entries(counts).map(([n, c]) => `${n} x${c}`).join(', ')
        bot.chat((text || 'пусто').slice(0, 250))
        break
      }
      case '!дай':
        if (!args[0]) return bot.chat('Пример: !дай oak_log 10')
        giveItem(username, args[0], Number(args[1]) || 0)
        break
      case '!где': {
        const p = bot.entity.position
        bot.chat(`Я тут: ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`)
        break
      }
      case '!помощь':
        bot.chat(HELP)
        break
      case '!ключ': {
        const key = args[0]
        if (!key) return bot.chat('Напиши: !ключ <твой ключ Groq>. Лучше шёпотом: /msg ' + bot.username + ' !ключ ...')
        if (!/^gsk_[A-Za-z0-9]{20,}$/.test(key)) return bot.whisper(username, 'Это не похоже на ключ Groq (должен начинаться с gsk_)')
        groqKey = key
        try { fs.writeFileSync(KEY_FILE, key, { mode: 0o600 }) } catch (err) { console.log('Не смог сохранить ключ:', err.message) }
        bot.whisper(username, 'Ключ принят, теперь я умею общаться. Пиши мне "бот, ..." или шепчи в личку.')
        if (!whisper) bot.whisper(username, 'Ключ виден всем в чате! Лучше создай новый на сайте Groq и передавай шёпотом.')
        break
      }
    }
  }

  async function aiReply (username, text, whisper) {
    const say = (msg) => (whisper ? bot.whisper(username, msg) : bot.chat(msg))
    if (!groqKey) return say('Нет ключа Groq. Напиши !ключ <ключ>')
    if (aiBusy) return
    aiBusy = true
    try {
      const p = bot.entity.position
      const state = `здоровье ${Math.round(bot.health)}, еда ${bot.food}, позиция ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
      const out = await askGroq(username, text, state)
      if (out.say) say(String(out.say).slice(0, 220))
      const cmd = String(out.cmd || '').trim()
      if (cmd && AI_COMMANDS.has(cmd.split(/\s+/)[0])) handle(username, cmd, whisper)
    } catch (err) {
      console.log('Groq:', err.message, err.cause?.message || '')
      say(err.status === 401 ? 'Ключ Groq не подошёл, пришли новый через !ключ' : `Мозг не отвечает: ${err.message} ${err.cause?.code || ''}`.trim())
    }
    aiBusy = false
  }

  function onMessage (username, message, whisper) {
    if (username === bot.username) return
    if (OWNER && username !== OWNER) return
    if (message.startsWith('!')) return handle(username, message, whisper)
    const lower = message.toLowerCase()
    if (whisper || lower.startsWith('бот') || lower.includes(bot.username.toLowerCase())) aiReply(username, message, whisper)
  }

  // ---------- события ----------

  bot.once('spawn', () => {
    const movements = new Movements(bot)
    movements.allowSprinting = true
    movements.canOpenDoors = true
    bot.pathfinder.setMovements(movements)
    console.log(`Бот зашёл на ${HOST}:${PORT}`)
    bot.chat('привет')
    autoArmor()
  })

  bot.on('playerJoined', (player) => {
    if (player.username !== bot.username) bot.chat(`привет, ${player.username}! Команды: !помощь`)
  })

  bot.on('chat', (username, message) => onMessage(username, message, false))
  bot.on('whisper', (username, message) => onMessage(username, message, true))

  bot.on('health', () => autoEat())
  bot.on('playerCollect', (collector) => {
    if (collector === bot.entity) { autoArmor(); autoEat() }
  })
  bot.on('death', () => {
    task++
    fighting = false
  })

  // бой и побег
  const combatLoop = setInterval(async () => {
    if (!guard || !bot.entity) return
    const mob = bot.nearestEntity((e) => e.type === 'hostile' && e.position.distanceTo(bot.entity.position) < 6)
    if (!mob) {
      fighting = false
      return
    }
    fighting = true
    if (bot.health <= 6) {
      bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(mob, 10)), true)
      autoEat()
      return
    }
    if (!bot.heldItem || !/_(sword|axe)$/.test(bot.heldItem.name)) await equipWeapon()
    const dist = mob.position.distanceTo(bot.entity.position)
    if (dist > 3) bot.pathfinder.setGoal(new goals.GoalFollow(mob, 2), true)
    else {
      bot.pathfinder.setGoal(null)
      bot.lookAt(mob.position.offset(0, mob.height * 0.9, 0), true)
      bot.attack(mob)
    }
  }, 500)

  bot.on('kicked', (reason) => console.log('Кикнут:', reason))
  bot.on('error', (err) => console.log('Ошибка:', err.message))
  bot.on('end', async () => {
    clearInterval(combatLoop)
    console.log('Отключён, переподключаюсь через 10 секунд...')
    await sleep(10000)
    start()
  })
}

start()
