const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const HOST = process.env.MC_HOST || 'Artyo228.aternos.me'
const PORT = Number(process.env.MC_PORT || 40864)
const VERSION = process.env.MC_VERSION || '1.21.11'
const USERNAME = process.env.MC_USER || 'poop173'
const OWNER = process.env.MC_OWNER || '' // пусто = слушаться всех

const HELP = '!иди !следуй !руби !копай [блок] !стой !защита !дом !домой !спи !инв !дай <предмет> [кол] !где'
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew'])
const ARMOR_RANK = { leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6 }
const ARMOR_SLOT = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }
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

  function handle (username, message) {
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
    }
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

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    if (OWNER && username !== OWNER) return
    handle(username, message)
  })

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
