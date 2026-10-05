const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const HOST = process.env.MC_HOST || 'Artyo228.aternos.me'
const PORT = Number(process.env.MC_PORT || 40864)
const VERSION = process.env.MC_VERSION || '1.21.11'
const USERNAME = process.env.MC_USER || 'poop173'
const OWNER = process.env.MC_OWNER || '' // пусто = слушаться всех
const KEY_FILE = path.join(__dirname, '.groq_key')
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
const GROQ_URL = 'https://api.groq.com/openai/v1'

// описание команд: его видит и игрок (!помощь), и нейросеть
const COMMANDS = {
  '!иди': '[x y z] — подойти к игроку или на координаты',
  '!следуй': '— ходить за игроком',
  '!руби': '[кол] — рубить деревья (по умолчанию 10)',
  '!копай': '<блок> [кол] — добывать блок, например iron_ore, stone, dirt (по умолчанию 16)',
  '!крафт': '<предмет> [кол] — скрафтить, сам сделает доски, палки и верстак',
  '!плавь': '<предмет> [кол] — переплавить в печке, например raw_iron',
  '!охота': '[животное] [кол] — охотиться на cow, pig, sheep, chicken',
  '!ферма': '— собрать спелые посевы и посадить заново',
  '!рыба': '[сек] — рыбачить удочкой',
  '!строй': '<дом|стена|столб> [блок] — построить из блоков инвентаря',
  '!атакуй': '<ник или моб> — атаковать цель',
  '!сундук': '<положи|возьми> [предмет] [кол] — ближайший сундук',
  '!исследуй': '— уйти в случайную сторону на 40 блоков',
  '!возьми': '<предмет> — взять предмет в руку',
  '!выбрось': '<предмет|всё> — выбросить',
  '!ешь': '— поесть',
  '!спи': '— лечь в ближайшую кровать',
  '!дом': '— запомнить это место как дом',
  '!домой': '— вернуться домой',
  '!дай': '<предмет> [кол] — принести и отдать игроку',
  '!инв': '— показать инвентарь',
  '!где': '— координаты бота',
  '!защита': '— вкл/выкл защиту от мобов',
  '!сам': '[цель|стоп] — играть самостоятельно с помощью нейросети',
  '!стой': '— остановить всё',
  '!ключ': '<ключ Groq> — подключить нейросеть (лучше шёпотом)',
  '!помощь': '— список команд'
}
// команды, которые не прерывают текущую задачу
const INFO_COMMANDS = new Set(['!инв', '!где', '!помощь', '!ключ', '!защита', '!дом'])
// команды, которые нейросеть не может вызывать
const AI_FORBIDDEN = new Set(['!ключ', '!сам', '!помощь'])

const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew'])
const ARMOR_RANK = { leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6 }
const TOOL_RANK = { wooden: 1, golden: 1, stone: 2, iron: 4, diamond: 5, netherite: 6 }
const ARMOR_SLOT = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }
const ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat']
const CROPS = { wheat: ['wheat_seeds', 7], carrots: ['carrot', 7], potatoes: ['potato', 7], beetroots: ['beetroot_seeds', 3] }
const BUILD_BLOCK = /planks|cobblestone|^stone$|^dirt$|_log$|bricks|cobbled_deepslate|sandstone|^andesite$|^diorite$|^granite$|^deepslate$|^tuff$|^glass$/
const INTEREST = /_log$|_ore$|^crafting_table$|^furnace$|^chest$|_bed$|^wheat$|^carrots$|^potatoes$|^beetroots$/
const KEEP = /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$|^fishing_rod$|^shield$|^bow$|^arrow$|^torch$|^crafting_table$/
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- нейросеть Groq (живёт между переподключениями) ----------

let groqKey = process.env.GROQ_API_KEY || ''
try { if (!groqKey) groqKey = fs.readFileSync(KEY_FILE, 'utf8').trim() } catch (_) {}
const PREFERRED_MODELS = ['llama-3.3-70b', 'llama-4', 'gpt-oss-120b', 'kimi', 'qwen', 'gpt-oss-20b', 'llama-3.1-8b']
let groqModel = GROQ_MODEL

function groqError (status) {
  return Object.assign(new Error(`Groq ${status}`), { status })
}

async function pickModel () {
  const res = await fetch(`${GROQ_URL}/models`, { headers: { Authorization: `Bearer ${groqKey}` } })
  if (!res.ok) throw groqError(res.status)
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
    body: JSON.stringify({ model: groqModel, messages, temperature: 0.5, max_tokens: 400 })
  })
}

// отправляет диалог и возвращает {raw, say, cmds}
async function askGroq (messages) {
  let res = await groqChat(messages)
  if (res.status === 404 || res.status === 400) {
    // модель убрали или переименовали: берём доступную и пробуем ещё раз
    console.log('Groq ответ:', res.status, (await res.text().catch(() => '')).slice(0, 300))
    await pickModel()
    res = await groqChat(messages)
  }
  if (!res.ok) {
    console.log('Groq ответ:', res.status, (await res.text().catch(() => '')).slice(0, 300))
    throw groqError(res.status)
  }
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content || ''
  return { raw: content, ...parseReply(content) }
}

function parseReply (content) {
  const m = content.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      const obj = JSON.parse(m[0])
      let cmds = obj.cmds || obj.cmd || []
      if (!Array.isArray(cmds)) cmds = [cmds]
      cmds = cmds.map((c) => String(c).trim()).filter((c) => c.startsWith('!'))
      return { say: obj.say ? String(obj.say) : '', cmds }
    } catch (_) {}
  }
  return { say: content.replace(/\s+/g, ' ').slice(0, 200), cmds: [] }
}

const COMMAND_LIST = Object.entries(COMMANDS)
  .filter(([c]) => !AI_FORBIDDEN.has(c))
  .map(([c, d]) => `${c} ${d}`)
  .join('\n')

const SYSTEM_BASE = `Ты Minecraft-бот по имени ${USERNAME} на ванильном сервере 1.21 (выживание). Ты умный, дружелюбный, говоришь по-русски коротко (до 200 символов).
Ты управляешь телом через команды. Доступные команды:
${COMMAND_LIST}
Имена предметов и блоков пиши по-английски, как в игре (oak_log, iron_ingot, wooden_pickaxe).
Можешь дать план из нескольких команд, они выполнятся по очереди. Думай как опытный игрок: сначала дерево, верстак и инструменты, потом камень, потом железо.
Ответь строго JSON без пояснений: {"say":"текст в чат или пусто","cmds":["!команда", ...]}`

const aiHistory = []

// ---------- бот ----------

function start () {
  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    version: VERSION,
    username: USERNAME,
    auth: 'offline'
  })
  bot.loadPlugin(pathfinder)

  let epoch = 0 // смена эпохи отменяет текущие задачи
  let guard = true
  let fighting = false
  let eating = false
  let armoring = false
  let aiBusy = false
  let auto = null // {goal, id} в режиме самостоятельной игры
  let home = null
  const badBlocks = new Set() // блоки, до которых не смогли добраться
  const events = [] // последние события для нейросети

  function note (msg) {
    events.push(msg)
    if (events.length > 8) events.shift()
  }

  function newEpoch () {
    epoch++
    const my = epoch
    return () => my === epoch
  }

  function stopAll () {
    epoch++
    auto = null
    bot.pathfinder.setGoal(null)
    try { bot.stopDigging() } catch (_) {}
  }

  // ---------- общие помощники ----------

  async function goTo (goal, ms = 30000) {
    let timer
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        bot.pathfinder.setGoal(null)
        reject(new Error('не дошёл'))
      }, ms)
    })
    try {
      await Promise.race([bot.pathfinder.goto(goal), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  const goNear = (pos, range = 2, ms) => goTo(new goals.GoalNear(pos.x, pos.y, pos.z, range), ms)

  async function waitCalm (alive) {
    while (fighting && alive()) await bot.waitForTicks(10)
  }

  function countItem (name) {
    return bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0)
  }

  function findItem (name) {
    name = name.toLowerCase()
    return bot.inventory.items().find((i) => i.name === name) ||
      bot.inventory.items().find((i) => i.name.includes(name) || i.displayName.toLowerCase().includes(name))
  }

  function inventorySummary (limit = 30) {
    const counts = {}
    for (const i of bot.inventory.items()) counts[i.name] = (counts[i.name] || 0) + i.count
    const list = Object.entries(counts).map(([n, c]) => `${n} x${c}`)
    return list.slice(0, limit).join(', ') || 'пусто'
  }

  function isAir (block) {
    return !block || block.boundingBox === 'empty'
  }

  // ---------- инвентарь и выживание ----------

  async function equipBestTool (block) {
    let best = null
    let bestTime = block.digTime(null, false, false, false, [], {})
    for (const item of bot.inventory.items()) {
      const t = block.digTime(item.type, false, false, false, [], {})
      if (t < bestTime) { best = item; bestTime = t }
    }
    try {
      if (best) await bot.equip(best, 'hand')
      else if (bot.heldItem && /_(pickaxe|axe|shovel|hoe|sword)$/.test(bot.heldItem.name)) await bot.unequip('hand')
    } catch (_) {}
  }

  async function equipWeapon () {
    const rank = (i) => (i.name.endsWith('sword') ? 10 : 0) + (TOOL_RANK[i.name.split('_')[0]] || 0)
    const weapons = bot.inventory.items().filter((i) => /_(sword|axe)$/.test(i.name)).sort((a, b) => rank(b) - rank(a))
    if (weapons.length) try { await bot.equip(weapons[0], 'hand') } catch (_) {}
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

  async function eat (force = false) {
    if (eating || bot.food === undefined || (!force && bot.food > 14) || bot.food >= 20) return false
    const food = bot.inventory.items().filter((i) => bot.registry.foodsByName[i.name] && !BAD_FOOD.has(i.name))
    if (!food.length) return false
    food.sort((a, b) => bot.registry.foodsByName[b.name].foodPoints - bot.registry.foodsByName[a.name].foodPoints)
    eating = true
    try {
      await bot.equip(food[0], 'hand')
      await bot.consume()
      return true
    } catch (_) {
      return false
    } finally {
      eating = false
    }
  }

  async function pickupDrops (radius = 8) {
    await bot.waitForTicks(8)
    for (let i = 0; i < 5; i++) {
      const drop = bot.nearestEntity((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < radius)
      if (!drop) return
      try { await goNear(drop.position, 1, 6000) } catch (_) { return }
    }
  }

  // ставит блок в pos, опираясь на соседний твёрдый блок
  async function placeAt (pos, itemName) {
    if (!isAir(bot.blockAt(pos))) return true
    if (!findItem(itemName)) return false
    const dirs = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)]
    const ref = dirs.map((d) => bot.blockAt(pos.plus(d))).find((b) => b && b.boundingBox === 'block')
    if (!ref) return false
    if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4) await goNear(pos, 3, 15000)
    const feet = bot.entity.position.floored()
    if (feet.equals(pos) || feet.offset(0, 1, 0).equals(pos)) {
      await goTo(new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1)), 5000).catch(() => {})
    }
    await bot.equip(findItem(itemName), 'hand')
    try {
      await bot.placeBlock(ref, pos.minus(ref.position))
    } catch (_) {}
    return !isAir(bot.blockAt(pos))
  }

  // ставит предмет-блок (верстак, печку) рядом с ботом
  async function placeNearby (itemName) {
    const base = bot.entity.position.floored()
    for (let r = 1; r <= 3; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          for (const dy of [0, 1, -1]) {
            const pos = base.offset(dx, dy, dz)
            const below = bot.blockAt(pos.offset(0, -1, 0))
            if (isAir(bot.blockAt(pos)) && isAir(bot.blockAt(pos.offset(0, 1, 0))) && below && below.boundingBox === 'block') {
              if (await placeAt(pos, itemName)) return bot.blockAt(pos)
            }
          }
        }
      }
    }
    return null
  }

  // ---------- крафт ----------

  async function getStation (name, alive) {
    let block = bot.findBlock({ matching: (b) => b.name === name, maxDistance: 24 })
    if (!block) {
      if (!countItem(name) && !(await ensureItem(name, 1, alive, 0, new Set()))) return null
      block = await placeNearby(name)
      if (!block) return null
    }
    await goNear(block.position, 2, 20000)
    return bot.blockAt(block.position)
  }

  function recipeScore (recipe) {
    let score = 0
    for (const d of recipe.delta) {
      if (d.count >= 0) continue
      const have = countItem(bot.registry.items[d.id].name)
      if (have >= -d.count) score += 3
      else if (have > 0) score += 2
      else if (bot.recipesAll(d.id, null, true).some((r) => r.delta.some((x) => x.count < 0 && countItem(bot.registry.items[x.id].name) > 0))) score += 1
    }
    return score
  }

  // добывает предмет крафтом, при необходимости крафтит промежуточные; missing — чего не хватило
  async function ensureItem (name, need, alive, depth, missing) {
    if (countItem(name) >= need) return true
    const item = bot.registry.itemsByName[name]
    if (!item || depth > 5 || !alive()) { missing.add(name); return false }
    const recipes = bot.recipesAll(item.id, null, true).sort((a, b) => recipeScore(b) - recipeScore(a)).slice(0, 3)
    if (!recipes.length) { missing.add(name); return false }
    for (const recipe of recipes) {
      // верстак ставим заранее, иначе он съест подготовленные доски
      let table = null
      if (recipe.requiresTable) {
        table = await getStation('crafting_table', alive)
        if (!table) { missing.add('crafting_table'); continue }
      }
      const times = Math.ceil((need - countItem(name)) / recipe.result.count)
      const ingredients = recipe.delta.filter((d) => d.count < 0).map((d) => [bot.registry.items[d.id].name, -d.count * times])
      let ok = false
      for (let round = 0; round < 3 && !ok && alive(); round++) {
        ok = true
        for (const [ing, amount] of ingredients) {
          if (!(await ensureItem(ing, amount, alive, depth + 1, missing))) { ok = false; break }
        }
        // промежуточный крафт мог потратить уже готовое: проверяем ещё раз
        if (ok) ok = ingredients.every(([ing, amount]) => countItem(ing) >= amount)
        else break
      }
      if (!ok) continue
      if (table) await goNear(table.position, 2, 20000)
      let errors = 0
      for (let i = 0; i < 64 && countItem(name) < need && alive() && errors < 3; i++) {
        const ready = bot.recipesFor(item.id, null, 1, table)
        if (!ready.length) break
        try {
          await bot.craft(ready[0], 1, table)
        } catch (err) {
          console.log('craft:', err.message)
          errors++
          await bot.waitForTicks(10)
        }
        await bot.waitForTicks(2)
      }
      if (countItem(name) >= need) return true
    }
    return false
  }

  async function craft (name, count, alive, say) {
    if (!bot.registry.itemsByName[name]) return say(`Не знаю предмет ${name}`)
    const target = countItem(name) + count
    const missing = new Set()
    try {
      if (await ensureItem(name, target, alive, 0, missing)) return say(`Скрафтил ${name} x${count}`)
    } catch (err) {
      return say(`Крафт ${name} не вышел: ${err.message}`.slice(0, 200))
    }
    const raw = [...missing].filter((m) => !bot.registry.itemsByName[m] || !bot.recipesAll(bot.registry.itemsByName[m].id, null, true).length)
    say(`Не хватает для ${name}: ${(raw.length ? raw : [...missing]).slice(0, 5).join(', ')}`)
  }

  // ---------- печка ----------

  async function smelt (inputName, count, alive, say) {
    const input = findItem(inputName)
    if (!input) return say(`Нет ${inputName}`)
    count = Math.min(count || countItem(input.name), countItem(input.name))
    const fuels = bot.inventory.items().filter((i) => /^(coal|charcoal)$|_planks$|_log$/.test(i.name))
    fuels.sort((a, b) => (/coal/.test(b.name) ? 1 : 0) - (/coal/.test(a.name) ? 1 : 0))
    if (!fuels.length) return say('Нет топлива (уголь, доски или брёвна)')
    const fuel = fuels[0]
    const fuelCount = Math.min(fuel.count, /coal/.test(fuel.name) ? Math.ceil(count / 8) : Math.ceil(count / 1.5))
    const block = await getStation('furnace', alive)
    if (!block) return say('Нет печки и не из чего сделать (нужно 8 cobblestone)')
    const furnace = await bot.openFurnace(block)
    let got = 0
    try {
      await furnace.putFuel(fuel.type, null, fuelCount)
      await furnace.putInput(input.type, null, count)
      say(`Плавлю ${input.name} x${count}`)
      const deadline = Date.now() + count * 11000 + 15000
      while (got < count && Date.now() < deadline && alive()) {
        await sleep(2000)
        const out = furnace.outputItem()
        if (out) {
          got += out.count
          await furnace.takeOutput()
        }
      }
    } finally {
      furnace.close()
    }
    say(`Переплавил ${got} шт.`)
  }

  // ---------- задачи ----------

  async function gather (match, label, limit, alive, say) {
    let count = 0
    let fails = 0
    while (alive() && count < limit) {
      await waitCalm(alive)
      const block = bot.findBlock({
        matching: (b) => match(b.name),
        maxDistance: 48,
        useExtraInfo: (b) => !badBlocks.has(b.position.toString())
      })
      if (!block) break
      try {
        await goNear(block.position, 3)
        if (!alive()) return
        const target = bot.blockAt(block.position)
        if (!target || !match(target.name)) continue
        if (!bot.canDigBlock(target)) throw new Error('не достать')
        await equipBestTool(target)
        if (!target.canHarvest(bot.heldItem ? bot.heldItem.type : null)) {
          say(`Для ${target.name} нужен инструмент получше`)
          return
        }
        await bot.dig(target)
        count++
        fails = 0
        await pickupDrops()
      } catch (err) {
        if (!alive()) return
        badBlocks.add(block.position.toString())
        console.log('gather:', err.message)
        if (++fails >= 8) break
        await bot.waitForTicks(10)
      }
    }
    if (alive()) say(`${label}: добыл ${count}`)
  }

  // бьёт сущность, пока она жива; true если убил
  async function fight (target, alive, ms = 60000) {
    await equipWeapon()
    const end = Date.now() + ms
    while (alive() && bot.entities[target.id] && Date.now() < end) {
      if (target.position.distanceTo(bot.entity.position) > 3) {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 1.5), true)
      } else {
        bot.pathfinder.setGoal(null)
        await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true)
        bot.attack(target)
      }
      await sleep(600)
    }
    bot.pathfinder.setGoal(null)
    return !bot.entities[target.id]
  }

  async function hunt (kind, limit, alive, say) {
    const kinds = kind ? [kind] : ANIMALS
    let killed = 0
    while (alive() && killed < limit) {
      await waitCalm(alive)
      const target = bot.nearestEntity((e) => kinds.includes(e.name) && e.position.distanceTo(bot.entity.position) < 40)
      if (!target) break
      if (await fight(target, alive, 40000)) killed++
      await pickupDrops()
    }
    if (alive()) say(`Охота: добыл ${killed}`)
  }

  async function farm (alive, say) {
    let harvested = 0
    while (alive()) {
      const crop = bot.findBlock({
        matching: (b) => CROPS[b.name] && b.getProperties().age >= CROPS[b.name][1],
        maxDistance: 32,
        useExtraInfo: (b) => !badBlocks.has(b.position.toString())
      })
      if (!crop) break
      const [seed] = CROPS[crop.name]
      try {
        await goNear(crop.position, 2)
        await bot.dig(bot.blockAt(crop.position))
        harvested++
        const soil = bot.blockAt(crop.position.offset(0, -1, 0))
        const seedItem = findItem(seed)
        if (soil && soil.name === 'farmland' && seedItem) {
          await bot.equip(seedItem, 'hand')
          await bot.placeBlock(soil, new Vec3(0, 1, 0)).catch(() => {})
        }
      } catch (err) {
        badBlocks.add(crop.position.toString())
      }
    }
    await pickupDrops(12)
    if (alive()) say(`Ферма: собрал ${harvested}`)
  }

  async function fishing (seconds, alive, say) {
    const rod = findItem('fishing_rod')
    if (!rod) return say('Нет удочки (fishing_rod)')
    const water = bot.findBlock({ matching: (b) => b.name === 'water', maxDistance: 24 })
    if (!water) return say('Не вижу воды')
    await goNear(water.position, 3)
    await bot.equip(rod, 'hand')
    await bot.lookAt(water.position.offset(0.5, 0.5, 0.5))
    say('Рыбачу')
    const end = Date.now() + seconds * 1000
    let caught = 0
    const watcher = setInterval(() => { if (!alive() || Date.now() > end) bot.activateItem() }, 1000)
    try {
      while (alive() && Date.now() < end) {
        try { await bot.fish(); caught++ } catch (_) { break }
      }
    } finally {
      clearInterval(watcher)
    }
    say(`Поймал ${caught}`)
  }

  function buildPlan (shape, origin) {
    const pos = []
    if (shape === 'дом') {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 5; x++) {
          for (let z = 0; z < 5; z++) {
            const edge = x === 0 || x === 4 || z === 0 || z === 4
            const door = x === 2 && z === 0 && y < 2
            if (edge && !door) pos.push(origin.offset(x, y, z))
          }
        }
      }
      for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) pos.push(origin.offset(x, 3, z))
    } else if (shape === 'стена') {
      for (let y = 0; y < 3; y++) for (let x = 0; x < 7; x++) pos.push(origin.offset(x, y, 0))
    } else if (shape === 'столб') {
      for (let y = 0; y < 5; y++) pos.push(origin.offset(0, y, 0))
    }
    return pos
  }

  async function build (shape, blockName, alive, say) {
    let material = blockName
    if (!material) {
      const counts = {}
      for (const i of bot.inventory.items()) if (BUILD_BLOCK.test(i.name)) counts[i.name] = (counts[i.name] || 0) + i.count
      material = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
    }
    if (!material || !findItem(material)) return say('Нет блоков для стройки')
    const plan = buildPlan(shape, bot.entity.position.floored().offset(2, 0, -2))
    if (!plan.length) return say('Умею строить: дом, стена, столб')
    say(`Строю ${shape} из ${material}, нужно ~${plan.length}, есть ${countItem(material)}`)
    let left = plan
    let placed = 0
    while (left.length && alive()) {
      const next = []
      let progress = false
      for (const pos of left) {
        if (!alive()) return
        await waitCalm(alive)
        if (!findItem(material)) return say(`Кончился ${material}, поставил ${placed}`)
        let ok = false
        try { ok = await placeAt(pos, material) } catch (_) {}
        if (ok) { placed++; progress = true } else next.push(pos)
      }
      left = next
      if (!progress) break
    }
    if (alive()) say(left.length ? `Построил частично: ${placed}, не смог ${left.length}` : `Готово! Поставил ${placed} блоков`)
  }

  async function chest (action, itemName, amount, say) {
    const block = bot.findBlock({ matching: (b) => b.name === 'chest' || b.name === 'barrel', maxDistance: 32 })
    if (!block) return say('Не вижу сундук')
    await goNear(block.position, 2)
    const box = await bot.openContainer(bot.blockAt(block.position))
    try {
      if (action === 'положи') {
        let moved = 0
        for (const item of bot.inventory.items()) {
          if (itemName ? !item.name.includes(itemName) : (KEEP.test(item.name) || bot.registry.foodsByName[item.name])) continue
          try { await box.deposit(item.type, null, item.count); moved += item.count } catch (_) {}
        }
        say(`Положил ${moved} предметов`)
      } else {
        const items = box.containerItems().filter((i) => !itemName || i.name.includes(itemName))
        if (!items.length) return say(itemName ? `В сундуке нет ${itemName}` : 'Сундук пуст')
        let taken = 0
        for (const item of items) {
          const n = amount ? Math.min(amount - taken, item.count) : item.count
          if (n <= 0) break
          try { await box.withdraw(item.type, null, n); taken += n } catch (_) {}
        }
        say(`Взял ${taken} предметов`)
      }
    } finally {
      box.close()
    }
  }

  async function giveItem (username, name, amount, say) {
    const player = bot.players[username]?.entity
    if (!player) return say('Не вижу тебя')
    const item = findItem(name)
    if (!item) return say(`У меня нет ${name}`)
    await goNear(player.position, 2)
    await bot.lookAt(player.position.offset(0, 1.6, 0))
    const total = countItem(item.name)
    await bot.toss(item.type, null, Math.min(amount || total, total))
    say('Держи')
  }

  async function goSleep (say) {
    const bed = bot.findBlock({ matching: (b) => b.name.endsWith('_bed'), maxDistance: 48 })
    if (!bed) return say('Не вижу кровать')
    await goNear(bed.position, 2)
    try {
      await bot.sleep(bot.blockAt(bed.position))
      say('Сплю')
    } catch (err) {
      say('Не могу уснуть: ' + err.message)
    }
  }

  // ---------- состояние для нейросети ----------

  function describeState () {
    const p = bot.entity.position
    const time = bot.time.timeOfDay
    const nearby = {}
    for (const pos of bot.findBlocks({ matching: (b) => INTEREST.test(b.name), maxDistance: 24, count: 300 })) {
      const name = bot.blockAt(pos)?.name
      if (name) nearby[name] = (nearby[name] || 0) + 1
    }
    const ents = {}
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || e.position.distanceTo(p) > 24) continue
      const name = e.type === 'player' ? `игрок ${e.username}` : e.name
      if (!name || name === 'item' || name === 'experience_orb') continue
      ents[name] = (ents[name] || 0) + 1
    }
    const fmt = (o) => Object.entries(o).map(([n, c]) => `${n} x${c}`).join(', ') || 'ничего'
    return [
      `здоровье ${Math.round(bot.health)}/20, еда ${bot.food}/20`,
      `позиция ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}, ${time < 12500 || time > 23500 ? 'день' : 'ночь'}`,
      `в руке: ${bot.heldItem ? bot.heldItem.name : 'ничего'}`,
      `инвентарь: ${inventorySummary()}`,
      `рядом блоки: ${fmt(nearby)}`,
      `рядом существа: ${fmt(ents)}`,
      `дом: ${home ? `${Math.floor(home.x)} ${Math.floor(home.y)} ${Math.floor(home.z)}` : 'не задан'}`,
      `последние события: ${events.join(' | ') || 'нет'}`
    ].join('\n')
  }

  // ---------- команды ----------

  // выполняет одну команду; промис завершается вместе с задачей
  async function handle (username, message, whisper = false, alive = null) {
    const [cmd, ...args] = message.trim().split(/\s+/)
    if (!COMMANDS[cmd]) return
    const say = (msg) => {
      note(`${cmd}: ${msg}`)
      if (whisper) bot.whisper(username, msg)
      else bot.chat(msg)
    }
    if (!alive) {
      if (INFO_COMMANDS.has(cmd)) alive = () => true
      else {
        // ручная команда прерывает текущую задачу и режим !сам
        if (auto && cmd !== '!сам') { auto = null; say('Режим !сам выключен') }
        bot.pathfinder.setGoal(null)
        alive = newEpoch()
      }
    }
    const player = bot.players[username]?.entity
    const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
    try {
      switch (cmd) {
        case '!иди':
          if (args.length >= 3 && args.slice(0, 3).every((a) => Number.isFinite(Number(a)))) {
            const [x, y, z] = args.map(Number)
            say(`Иду на ${x} ${y} ${z}`)
            await goTo(new goals.GoalNear(x, y, z, 1), 180000)
            say('Пришёл')
          } else {
            if (!player) return say('Не вижу тебя')
            await goNear(player.position, 2, 60000)
          }
          break
        case '!следуй':
          if (!player) return say('Не вижу тебя')
          bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true)
          say('Следую за тобой')
          break
        case '!руби':
          await gather((n) => n.endsWith('_log') || n.endsWith('_stem'), 'Дерево', num(args[0], 10), alive, say)
          break
        case '!копай': {
          const name = (args[0] || 'stone').toLowerCase()
          const names = new Set([name, `deepslate_${name}`, `${name}_ore`, `deepslate_${name}_ore`].filter((n) => bot.registry.blocksByName[n]))
          if (!names.size) return say(`Не знаю блок ${name}`)
          await gather((n) => names.has(n), name, num(args[1], 16), alive, say)
          break
        }
        case '!крафт':
          if (!args[0]) return say('Пример: !крафт wooden_pickaxe')
          await craft(args[0].toLowerCase(), num(args[1], 1), alive, say)
          break
        case '!плавь':
          if (!args[0]) return say('Пример: !плавь raw_iron 8')
          await smelt(args[0].toLowerCase(), num(args[1], 0), alive, say)
          break
        case '!охота': {
          const kind = args[0] && !Number(args[0]) ? args[0].toLowerCase() : null
          await hunt(kind, num(kind ? args[1] : args[0], 3), alive, say)
          break
        }
        case '!ферма':
          await farm(alive, say)
          break
        case '!рыба':
          await fishing(num(args[0], 120), alive, say)
          break
        case '!строй':
          await build(args[0] || 'дом', args[1], alive, say)
          break
        case '!атакуй': {
          const name = (args[0] || '').toLowerCase()
          const target = bot.nearestEntity((e) => e !== bot.entity &&
            ((e.username && e.username.toLowerCase() === name) || (e.name && e.name.toLowerCase() === name) || (!name && e.type === 'hostile')))
          if (!target) return say(`Не вижу ${name || 'врагов'}`)
          say(`Атакую ${target.username || target.name}`)
          say((await fight(target, alive)) ? 'Готово' : 'Цель ушла')
          break
        }
        case '!сундук':
          if (!['положи', 'возьми'].includes(args[0])) return say('Пример: !сундук положи или !сундук возьми iron_ingot 5')
          await chest(args[0], args[1], num(args[2], 0), say)
          break
        case '!исследуй': {
          const a = Math.random() * Math.PI * 2
          const p = bot.entity.position
          say('Иду исследовать')
          await goTo(new goals.GoalNearXZ(p.x + Math.cos(a) * 40, p.z + Math.sin(a) * 40, 3), 60000)
          break
        }
        case '!возьми': {
          const item = findItem(args[0] || '')
          if (!item) return say(`Нет ${args[0]}`)
          await bot.equip(item, 'hand')
          say(`Взял ${item.name}`)
          break
        }
        case '!выбрось':
          if (args[0] === 'всё' || args[0] === 'все') {
            for (const item of bot.inventory.items()) await bot.tossStack(item).catch(() => {})
            say('Выбросил всё')
          } else {
            const item = findItem(args[0] || '')
            if (!item) return say(`Нет ${args[0]}`)
            await bot.toss(item.type, null, Math.min(num(args[1], countItem(item.name)), countItem(item.name)))
            say(`Выбросил ${item.name}`)
          }
          break
        case '!ешь':
          say((await eat(true)) ? 'Поел' : 'Нечего есть или я сыт')
          break
        case '!спи':
          await goSleep(say)
          break
        case '!дом':
          home = bot.entity.position.clone()
          say(`Дом здесь: ${Math.floor(home.x)} ${Math.floor(home.y)} ${Math.floor(home.z)}`)
          break
        case '!домой':
          if (!home) return say('Дом не задан, используй !дом')
          await goNear(home, 2, 180000)
          say('Я дома')
          break
        case '!дай':
          if (!args[0]) return say('Пример: !дай oak_log 10')
          await giveItem(username, args[0], num(args[1], 0), say)
          break
        case '!инв':
          say(inventorySummary().slice(0, 250))
          break
        case '!где': {
          const p = bot.entity.position
          say(`Я тут: ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`)
          break
        }
        case '!защита':
          guard = !guard
          say(guard ? 'Защита включена' : 'Защита выключена')
          break
        case '!сам':
          if (args[0] === 'стоп') {
            auto = null
            say('Больше не играю сам')
          } else {
            if (!groqKey) return say('Сначала дай ключ: !ключ <ключ Groq>')
            const goal = args.join(' ') || 'выживай и развивайся: добудь ресурсы, сделай инструменты, построй дом'
            auto = { goal, id: Date.now() }
            say(`Играю сам. Цель: ${goal}`.slice(0, 200))
            autoLoop(auto.id)
          }
          break
        case '!стой':
          stopAll()
          say('Стою')
          break
        case '!помощь':
          say(Object.keys(COMMANDS).join(' '))
          break
        case '!ключ': {
          const key = args[0]
          if (!key) return say(`Напиши: !ключ <ключ Groq>. Лучше шёпотом: /msg ${bot.username} !ключ ...`)
          if (!/^gsk_[A-Za-z0-9]{20,}$/.test(key)) return bot.whisper(username, 'Это не похоже на ключ Groq (должен начинаться с gsk_)')
          groqKey = key
          try { fs.writeFileSync(KEY_FILE, key, { mode: 0o600 }) } catch (err) { console.log('Не смог сохранить ключ:', err.message) }
          bot.whisper(username, 'Ключ принят! Пиши мне "бот, ..." или !сам')
          if (!whisper) bot.whisper(username, 'Ключ виден всем в чате! Создай новый на сайте Groq и передавай шёпотом.')
          break
        }
      }
    } catch (err) {
      if (alive()) say(`${cmd}: ${err.message}`.slice(0, 200))
    }
  }

  // выполняет план нейросети по очереди
  async function runPlan (cmds, username, whisper, alive) {
    for (const c of cmds.slice(0, 6)) {
      if (!alive()) return
      const name = c.split(/\s+/)[0]
      if (AI_FORBIDDEN.has(name) || !COMMANDS[name]) continue
      console.log('План:', c)
      await handle(username, c, whisper, alive)
    }
  }

  async function aiReply (username, text, whisper) {
    const say = (msg) => (whisper ? bot.whisper(username, msg) : bot.chat(msg))
    if (!groqKey) return say('Нет ключа Groq. Напиши !ключ <ключ>')
    if (aiBusy) return
    aiBusy = true
    let out
    try {
      aiHistory.push({ role: 'user', content: `${username}: ${text}` })
      if (aiHistory.length > 12) aiHistory.splice(0, aiHistory.length - 12)
      out = await askGroq([{ role: 'system', content: `${SYSTEM_BASE}\nТвоё состояние:\n${describeState()}` }, ...aiHistory])
      aiHistory.push({ role: 'assistant', content: out.raw })
      if (out.say) say(out.say.slice(0, 220))
    } catch (err) {
      aiHistory.pop()
      console.log('Groq:', err.message, err.cause?.message || '')
      say(err.status === 401 ? 'Ключ Groq не подошёл, пришли новый через !ключ' : `Мозг не отвечает: ${err.message}`)
    }
    aiBusy = false
    if (out && out.cmds.length) {
      if (auto) { auto = null; say('Режим !сам выключен') }
      bot.pathfinder.setGoal(null)
      await runPlan(out.cmds, username, whisper, newEpoch())
    }
  }

  // самостоятельная игра: спрашивает нейросеть, что делать, и выполняет
  async function autoLoop (id) {
    const running = () => auto && auto.id === id
    const owner = OWNER || Object.keys(bot.players).find((n) => n !== bot.username) || ''
    const history = []
    while (running()) {
      await waitCalm(running)
      if (!running()) return
      let out
      try {
        history.push({ role: 'user', content: `Цель: ${auto.goal}\nСостояние:\n${describeState()}\nЧто делаешь дальше? Дай план из 1-4 команд.` })
        if (history.length > 8) history.splice(0, history.length - 8)
        out = await askGroq([{ role: 'system', content: `${SYSTEM_BASE}\nСейчас ты играешь сам. Ночью лучше спать или строить, при низкой еде — охота или ферма.` }, ...history])
        history.push({ role: 'assistant', content: out.raw })
      } catch (err) {
        history.pop()
        console.log('Groq (сам):', err.message)
        if (err.status === 401) { bot.chat('Ключ Groq не подошёл'); auto = null; return }
        await sleep(err.status === 429 ? 30000 : 10000)
        continue
      }
      if (!running()) return
      if (out.say) bot.chat(out.say.slice(0, 220))
      if (!out.cmds.length) { await sleep(15000); continue }
      const alive = newEpoch()
      await runPlan(out.cmds, owner, false, () => alive() && running())
      await sleep(3000)
    }
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

  bot.on('health', () => eat())
  bot.on('playerCollect', (collector) => {
    if (collector === bot.entity) { autoArmor(); eat() }
  })
  bot.on('death', () => {
    epoch++
    fighting = false
    note('я умер')
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
      eat(true)
      return
    }
    if (!bot.heldItem || !/_(sword|axe)$/.test(bot.heldItem.name)) await equipWeapon()
    if (mob.position.distanceTo(bot.entity.position) > 3) bot.pathfinder.setGoal(new goals.GoalFollow(mob, 2), true)
    else {
      bot.pathfinder.setGoal(null)
      bot.lookAt(mob.position.offset(0, mob.height * 0.9, 0), true)
      bot.attack(mob)
    }
  }, 500)

  bot.on('kicked', (reason) => console.log('Кикнут:', JSON.stringify(reason)))
  bot.on('error', (err) => console.log('Ошибка:', err.message))
  bot.on('end', async () => {
    clearInterval(combatLoop)
    auto = null
    console.log('Отключён, переподключаюсь через 10 секунд...')
    await sleep(10000)
    start()
  })
}

start()
