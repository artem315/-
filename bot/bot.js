const mineflayer = require('mineflayer')

const HOST = process.env.MC_HOST || 'Artyo228.aternos.me'
const PORT = Number(process.env.MC_PORT || 40864)
const VERSION = process.env.MC_VERSION || '1.21.11'
const USERNAME = process.env.MC_USER || 'poop173'

function start () {
  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    version: VERSION,
    username: USERNAME,
    auth: 'offline'
  })

  bot.once('spawn', () => {
    console.log(`Бот зашёл на ${HOST}:${PORT}`)
    bot.chat('привет')
  })

  bot.on('playerJoined', (player) => {
    if (player.username !== bot.username) bot.chat(`привет, ${player.username}!`)
  })

  bot.on('kicked', (reason) => console.log('Кикнут:', reason))
  bot.on('error', (err) => console.log('Ошибка:', err.message))
  bot.on('end', () => {
    console.log('Отключён, переподключаюсь через 10 секунд...')
    setTimeout(start, 10000)
  })
}

start()
