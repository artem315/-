const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const HOST = process.env.MC_HOST || 'Artyo228.aternos.me'
const PORT = Number(process.env.MC_PORT || 40864)
const VERSION = process.env.MC_VERSION || '1.21.11'
const USERNAME = process.env.MC_USER || 'poop173'
const OWNER = process.env.MC_OWNER || '' // пусто = слушаться всех

const HELP = '!иди, !руби, !копай [блок], !стой, !защита, !помощь'

function start () {
  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    version: VERSION,
    username: USERNAME,
    auth: 'offline'
  })
  bot.loadPlugin(pathfinder)

  let task = 0 // номер текущей задачи, смена номера отменяет старую
  let guard = false

  function stop () {
    task++
    bot.pathfinder.setGoal(null)
  }

  function findBlock (match) {
    return bot.findBlock({ matching: (b) => match(b.name), maxDistance: 48 })
  }

  async function gather (match, label) {
    const id = ++task
    let count = 0
    while (id === task) {
      const block = findBlock(match)
      if (!block) {
        bot.chat(`${label}: больше не вижу, добыл ${count}`)
        return
      }
      try {
        await bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 3))
        if (id !== task) return
        await bot.dig(bot.blockAt(block.position))
        count++
      } catch (err) {
        if (id !== task) return
        console.log('gather:', err.message)
        await bot.waitForTicks(20)
      }
    }
  }

  function handle (username, message) {
    const [cmd, ...args] = message.trim().split(/\s+/)
    switch (cmd) {
      case '!иди': {
        const player = bot.players[username]?.entity
        if (!player) return bot.chat('Не вижу тебя')
        stop()
        const p = player.position
        bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 2))
        bot.chat('Иду')
        break
      }
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
      case '!помощь':
        bot.chat(HELP)
        break
    }
  }

  bot.once('spawn', () => {
    bot.pathfinder.setMovements(new Movements(bot))
    console.log(`Бот зашёл на ${HOST}:${PORT}`)
    bot.chat('привет')
  })

  bot.on('playerJoined', (player) => {
    if (player.username !== bot.username) bot.chat(`привет, ${player.username}! Команды: ${HELP}`)
  })

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    if (OWNER && username !== OWNER) return
    handle(username, message)
  })

  // защита: бьём ближайшего врага рядом
  setInterval(() => {
    if (!guard || !bot.entity) return
    const mob = bot.nearestEntity((e) => e.type === 'hostile' && e.position.distanceTo(bot.entity.position) < 5)
    if (!mob) return
    bot.lookAt(mob.position.offset(0, mob.height * 0.9, 0), true)
    if (mob.position.distanceTo(bot.entity.position) < 3.5) bot.attack(mob)
  }, 500)

  bot.on('kicked', (reason) => console.log('Кикнут:', reason))
  bot.on('error', (err) => console.log('Ошибка:', err.message))
  bot.on('end', () => {
    console.log('Отключён, переподключаюсь через 10 секунд...')
    setTimeout(start, 10000)
  })
}

start()
