import express from 'express';
import cors from 'cors';
import { Telegraf } from 'telegraf';
import mongoose from 'mongoose';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const MY_TOKEN = process.env.BOT_TOKEN || '';
const MONGO_URI = process.env.MONGO_URI || '';
const SUPER_ADMIN_ID = '5234247365';

const bot = new Telegraf(MY_TOKEN);

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 60000 })
  .then(async () => {
    console.log('✅ База данных подключена!');
    const superAdmin = await Admin.findOne({ telegramId: SUPER_ADMIN_ID });
    if (!superAdmin) await Admin.create({ telegramId: SUPER_ADMIN_ID, role: 'super' });
  })
  .catch(err => console.error('❌ Ошибка БД:', err.message));

// Схемы
const User = mongoose.model('User', new mongoose.Schema({
  telegramId: { type: String, unique: true, required: true },
  balance: { type: Number, default: 0 }
}));

const Admin = mongoose.model('Admin', new mongoose.Schema({
  telegramId: { type: String, unique: true, required: true },
  role: { type: String, enum: ['super', 'regular'], default: 'regular' }
}));

const Match = mongoose.model('Match', new mongoose.Schema({
  tournament: String, region: String, team1: String, team2: String,
  markets: [{ group: String, name: String, odds: Number }],
  date: { type: Date, default: Date.now },
  isLive: { type: Boolean, default: false }, isClosed: { type: Boolean, default: false }
}));

const Bet = mongoose.model('Bet', new mongoose.Schema({
  telegramId: String, matchName: String, market: String, odd: Number, stake: Number, potentialWin: Number,
  status: { type: String, default: 'pending' }, date: { type: Date, default: Date.now }
}));

const Transaction = mongoose.model('Transaction', new mongoose.Schema({
  telegramId: String, type: String, amount: Number, status: { type: String, default: 'success' }, date: { type: Date, default: Date.now }
}));

const Promo = mongoose.model('Promo', new mongoose.Schema({
  code: { type: String, unique: true, required: true },
  amount: { type: Number, required: true },
  limit: { type: Number, default: 100 },
  used: { type: Number, default: 0 },
  usedBy: [{ type: String }]
}));

// ==========================================
// ИГРА РУЛЕТКА
// ==========================================
const RED_NUMBERS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const wheelNumbers = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];

let rouletteState = {
  status: 'waiting', timer: 20, history: [9, 14, 9, 7, 3, 3, 4, 14, 10, 3],
  players: {}, currentBets: [], timerInterval: null
};

const maskId = (id) => {
  const str = String(id);
  if (str.length <= 5) return '***';
  return str.slice(0, 3) + '***' + str.slice(-2);
};

const broadcastRoulette = () => {
  io.emit('roulette_state', {
    status: rouletteState.status, timer: rouletteState.timer,
    history: rouletteState.history, currentBets: rouletteState.currentBets
  });
};

const startRouletteCountdown = () => {
  if (rouletteState.status !== 'waiting') return;
  rouletteState.status = 'countdown'; rouletteState.timer = 20; broadcastRoulette();

  rouletteState.timerInterval = setInterval(() => {
    rouletteState.timer -= 1; broadcastRoulette();
    if (rouletteState.timer <= 0) {
      clearInterval(rouletteState.timerInterval);
      spinRoulette();
    }
  }, 1000);
};

const spinRoulette = () => {
  rouletteState.status = 'spinning'; broadcastRoulette();
  const winningIndex = Math.floor(Math.random() * 37);
  const winningNumber = wheelNumbers[winningIndex];
  const winningColor = winningNumber === 0 ? 'green' : (RED_NUMBERS.includes(winningNumber) ? 'red' : 'black');

  io.emit('roulette_spin', { winningIndex });

  setTimeout(async () => {
    for (const socketId in rouletteState.players) {
      const player = rouletteState.players[socketId];
      const user = await User.findOne({ telegramId: player.telegramId });
      if (!user) continue;
      let totalBet = player.bets.red + player.bets.green + player.bets.black;
      if (totalBet === 0) continue;

      let winAmount = 0;
      if (player.bets[winningColor] > 0) {
        let mult = winningColor === 'green' ? 50 : 2;
        winAmount = player.bets[winningColor] * mult;
        user.balance += winAmount; await user.save();
        io.to(socketId).emit('roulette_result', { win: true, amount: winAmount, number: winningNumber, color: winningColor });
        io.to(socketId).emit('roulette_balance', { balance: user.balance });
      } else {
        io.to(socketId).emit('roulette_result', { win: false, amount: 0, number: winningNumber, color: winningColor });
      }
    }
    rouletteState.history = [winningNumber, ...rouletteState.history.slice(0, 9)];
    rouletteState.status = 'waiting'; rouletteState.timer = 20;
    rouletteState.players = {}; rouletteState.currentBets = [];
    broadcastRoulette();
  }, 4500);
};

// ==========================================
// ИГРА КРАШ (CRASH) С АВТОВЫВОДОМ
// ==========================================
let crashState = {
  status: 'waiting', multiplier: 1.00, crashPoint: 1.00,
  players: {}, 
  timer: 5, timerInterval: null, gameInterval: null,
  feed: []
};

const broadcastCrash = () => {
  io.emit('crash_state', {
    status: crashState.status, multiplier: crashState.multiplier, timer: crashState.timer, feed: crashState.feed
  });
};

const startCrashRound = () => {
  crashState.status = 'waiting';
  crashState.multiplier = 1.00;
  crashState.players = {};
  crashState.feed = [];
  crashState.timer = 10;
  broadcastCrash();

  crashState.timerInterval = setInterval(() => {
    crashState.timer -= 1;
    broadcastCrash();
    if (crashState.timer <= 0) {
      clearInterval(crashState.timerInterval);
      flyRocket();
    }
  }, 1000);
};

const flyRocket = () => {
  crashState.status = 'flying';
  const rand = Math.random();
  crashState.crashPoint = rand < 0.5 ? 1.00 + Math.random() * 1.5 : 1.5 + Math.random() * 8;
  broadcastCrash();

  crashState.gameInterval = setInterval(async () => {
    crashState.multiplier = Number((crashState.multiplier + 0.02).toFixed(2));
    
    // Проверяем автовывод для всех игроков
    for (const socketId in crashState.players) {
      const player = crashState.players[socketId];
      const user = await User.findOne({ telegramId: player.telegramId });
      if (!user) continue;

      player.bets.forEach(async (bet, index) => {
        // Если ставка есть, не выведена, и кэф достиг автовывода
        if (bet.amount && !bet.cashedOut && bet.autoCashout && crashState.multiplier >= bet.autoCashout) {
          const winAmount = Math.floor(bet.amount * bet.autoCashout);
          bet.cashedOut = true;
          bet.winAmount = winAmount;

          user.balance += winAmount;
          await user.save();

          crashState.feed.unshift({ 
            id: maskId(player.telegramId), 
            type: 'win', 
            amount: winAmount, 
            mult: bet.autoCashout, 
            slot: index + 1,
            isAuto: true 
          });
          if (crashState.feed.length > 15) crashState.feed.pop();

          io.to(socketId).emit('crash_balance', { balance: user.balance });
          io.to(socketId).emit('crash_cashout_success', { amount: winAmount, mult: bet.autoCashout, slot: index + 1 });
          broadcastCrash();
        }
      });
    }

    // Если кэф достиг точки краша
    if (crashState.multiplier >= crashState.crashPoint) {
      clearInterval(crashState.gameInterval);
      crashState.status = 'crashed';
      
      // Добавляем в ленту проигравших
      for (const socketId in crashState.players) {
        const player = crashState.players[socketId];
        player.bets.forEach((bet, index) => {
          if (bet.amount && !bet.cashedOut) {
            crashState.feed.unshift({ id: maskId(player.telegramId), type: 'lose', amount: bet.amount, slot: index + 1 });
          }
        });
      }
      
      broadcastCrash();

      setTimeout(() => startCrashRound(), 3000);
    } else {
      broadcastCrash();
    }
  }, 100);
};

io.on('connection', (socket) => {
  socket.emit('roulette_state', { status: rouletteState.status, timer: rouletteState.timer, history: rouletteState.history, currentBets: rouletteState.currentBets });
  socket.emit('crash_state', { status: crashState.status, multiplier: crashState.multiplier, timer: crashState.timer, feed: crashState.feed });

  socket.on('roulette_bet', async (data) => {
    const { telegramId, color, amount } = data;
    if (rouletteState.status === 'spinning') return;
    const user = await User.findOne({ telegramId });
    if (!user || user.balance < amount) return socket.emit('roulette_error', { message: 'Недостаточно средств' });
    user.balance -= amount; await user.save();

    if (!rouletteState.players[socket.id]) rouletteState.players[socket.id] = { telegramId, bets: { red: 0, green: 0, black: 0 } };
    rouletteState.players[socket.id].bets[color] += amount;
    rouletteState.currentBets.unshift({ maskedId: maskId(telegramId), color, amount });
    if (rouletteState.currentBets.length > 20) rouletteState.currentBets.pop();
    if (rouletteState.status === 'waiting') startRouletteCountdown();

    socket.emit('roulette_balance', { balance: user.balance });
    broadcastRoulette();
  });

  socket.on('crash_bet', async (data) => {
    const { telegramId, amount, slot, autoCashout } = data;
    if (crashState.status !== 'waiting') return socket.emit('crash_error', { message: 'Ставки закрыты' });
    const user = await User.findOne({ telegramId });
    if (!user || user.balance < amount) return socket.emit('crash_error', { message: 'Недостаточно средств' });
    
    user.balance -= amount; await user.save();
    
    if (!crashState.players[socket.id]) crashState.players[socket.id] = { telegramId, bets: [{}, {}] };
    crashState.players[socket.id].bets[slot - 1] = { amount, cashedOut: false, winAmount: 0, autoCashout };

    crashState.feed.unshift({ id: maskId(telegramId), type: 'bet', amount, slot });
    if (crashState.feed.length > 15) crashState.feed.pop();

    socket.emit('crash_balance', { balance: user.balance });
    broadcastCrash();
  });

  socket.on('crash_cashout', async (data) => {
    const { slot } = data;
    const player = crashState.players[socket.id];
    if (!player || crashState.status !== 'flying') return;
    
    const bet = player.bets[slot - 1];
    if (!bet || !bet.amount || bet.cashedOut) return;
    
    const winAmount = Math.floor(bet.amount * crashState.multiplier);
    bet.cashedOut = true;
    bet.winAmount = winAmount;

    const user = await User.findOne({ telegramId: player.telegramId });
    if (user) {
      user.balance += winAmount; await user.save();
      
      crashState.feed.unshift({ id: maskId(player.telegramId), type: 'win', amount: winAmount, mult: crashState.multiplier, slot });
      if (crashState.feed.length > 15) crashState.feed.pop();

      socket.emit('crash_balance', { balance: user.balance });
      socket.emit('crash_cashout_success', { amount: winAmount, mult: crashState.multiplier, slot });
      broadcastCrash();
    }
  });

  socket.on('disconnect', () => {
    delete rouletteState.players[socket.id];
    delete crashState.players[socket.id];
  });
});

setTimeout(() => startCrashRound(), 5000);

// ==========================================
// ОСТАЛЬНЫЕ API
// ==========================================
app.get('/api/user/:id', async (req, res) => {
  try {
    let user = await User.findOne({ telegramId: req.params.id });
    if (!user) user = await User.create({ telegramId: req.params.id, balance: 0 });
    res.json({ balance: user.balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/balance', async (req, res) => {
  const { telegramId, newBalance } = req.body;
  try {
    const user = await User.findOneAndUpdate({ telegramId }, { balance: newBalance }, { new: true, upsert: true });
    res.json({ balance: user.balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bets', async (req, res) => {
  const { telegramId, matchName, market, odd, stake, potentialWin } = req.body;
  try {
    const user = await User.findOne({ telegramId });
    if (!user || user.balance < stake) return res.status(400).json({ error: 'Недостаточно средств' });
    user.balance -= stake; await user.save();
    await Bet.create({ telegramId, matchName, market, odd, stake, potentialWin });
    res.json({ success: true, balance: user.balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bets/:id', async (req, res) => {
  try { res.json(await Bet.find({ telegramId: req.params.id }).sort({ date: -1 })); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/transactions/:id', async (req, res) => {
  try { res.json(await Transaction.find({ telegramId: req.params.id }).sort({ date: -1 })); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/withdraw', async (req, res) => {
  const { telegramId, amount } = req.body;
  if (amount < 100) return res.status(400).json({ error: 'Минимум 100 ₽' });
  try {
    const user = await User.findOne({ telegramId });
    if (!user || user.balance < amount) return res.status(400).json({ error: 'Недостаточно средств' });
    user.balance -= amount; await user.save();
    await Transaction.create({ telegramId, type: 'withdraw', amount, status: 'pending' });
    res.json({ balance: user.balance, message: 'Заявка создана' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/promo/activate', async (req, res) => {
  const { telegramId, code } = req.body;
  try {
    const promo = await Promo.findOne({ code: code.toUpperCase() });
    if (!promo) return res.status(400).json({ error: 'Промокод не найден' });
    if (promo.used >= promo.limit) return res.status(400).json({ error: 'Промокод больше не действителен' });
    if (promo.usedBy.includes(String(telegramId))) return res.status(400).json({ error: 'Вы уже активировали этот промокод' });

    const user = await User.findOne({ telegramId });
    if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
    user.balance += promo.amount; await user.save();
    promo.used += 1; promo.usedBy.push(String(telegramId)); await promo.save();
    await Transaction.create({ telegramId, type: 'deposit', amount: promo.amount, status: 'success' });
    res.json({ success: true, balance: user.balance, amount: promo.amount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/check/:id', async (req, res) => {
  try {
    const admin = await Admin.findOne({ telegramId: req.params.id });
    res.json({ isAdmin: !!admin, role: admin ? admin.role : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/list', async (req, res) => {
  if (String(req.query.telegramId) !== SUPER_ADMIN_ID) return res.status(403).json({ error: 'Доступ запрещен' });
  try { res.json(await Admin.find()); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/add', async (req, res) => {
  const { telegramId, newAdminId } = req.body;
  if (String(telegramId) !== SUPER_ADMIN_ID) return res.status(403).json({ error: 'Доступ запрещен' });
  try {
    if (await Admin.findOne({ telegramId: newAdminId })) return res.status(400).json({ error: 'Уже админ' });
    res.json(await Admin.create({ telegramId: newAdminId, role: 'regular' }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/:id', async (req, res) => {
  const { telegramId } = req.body;
  if (String(telegramId) !== SUPER_ADMIN_ID) return res.status(403).json({ error: 'Доступ запрещен' });
  if (req.params.id === SUPER_ADMIN_ID) return res.status(400).json({ error: 'Нельзя удалить Главного' });
  try { await Admin.deleteOne({ telegramId: req.params.id }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/promos', async (req, res) => {
  if (String(req.query.telegramId) !== SUPER_ADMIN_ID) return res.status(403).json({ error: 'Доступ запрещен' });
  try { res.json(await Promo.find().sort({ _id: -1 })); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/promo', async (req, res) => {
  const { telegramId, code, amount, limit } = req.body;
  if (String(telegramId) !== SUPER_ADMIN_ID) return res.status(403).json({ error: 'Доступ запрещен' });
  if (!code || !amount || !limit) return res.status(400).json({ error: 'Заполните все поля' });

  try {
    if (await Promo.findOne({ code: code.toUpperCase() })) return res.status(400).json({ error: 'Такой промокод уже существует' });
    const newPromo = await Promo.create({ code: code.toUpperCase(), amount: Number(amount), limit: Number(limit), used: 0, usedBy: [] });
    res.json(newPromo);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const checkAdmin = async (req, res, next) => {
  const id = req.body.telegramId || req.query.telegramId;
  const admin = await Admin.findOne({ telegramId: String(id) });
  if (!admin) return res.status(403).json({ error: 'Вы не администратор' });
  next();
};

app.get('/api/matches', async (req, res) => {
  try { res.json(await Match.find().sort({ date: -1 })); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/matches', checkAdmin, async (req, res) => {
  try { res.json(await Match.create(req.body)); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/matches/:id', checkAdmin, async (req, res) => {
  try { res.json(await Match.findByIdAndUpdate(req.params.id, req.body, { new: true })); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/matches/:id', checkAdmin, async (req, res) => {
  try { await Match.findByIdAndDelete(req.params.id); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/create-invoice', async (req, res) => {
  const { telegramId, packageAmount, packagePriceInStars } = req.body;
  try {
    const invoiceLink = await bot.telegram.createInvoiceLink({
      title: `Пополнение на ${packageAmount} ₽`, description: `Пакет ${packagePriceInStars} звезд`,
      payload: JSON.stringify({ userId: telegramId, amount: packageAmount }), 
      provider_token: '', currency: 'XTR', prices: [{ label: 'Пакет звезд', amount: packagePriceInStars }], 
    });
    res.json({ invoiceLink });
  } catch (err) { res.status(500).json({ error: 'Ошибка создания' }); }
});

bot.on('pre_checkout_query', async (ctx) => {
  try { await ctx.answerPreCheckoutQuery(true); } catch (err) { await ctx.answerPreCheckoutQuery(false, 'Ошибка'); }
});

bot.on('message', async (ctx) => {
  if (!ctx.message.successful_payment) return;
  const payment = ctx.message.successful_payment;
  const payload = JSON.parse(payment.invoice_payload);
  try {
    const user = await User.findOne({ telegramId: payload.userId.toString() });
    if (user) { user.balance += payload.amount; await user.save(); }
    else { await User.create({ telegramId: payload.userId.toString(), balance: payload.amount }); }
    await Transaction.create({ telegramId: payload.userId.toString(), type: 'deposit', amount: payload.amount });
    await ctx.reply(`✅ Зачислено ${payload.amount} ₽.`);
  } catch (err) { console.error(err); }
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Сервер на порту ${PORT}`);
  const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL; 
  if (WEBHOOK_URL && MY_TOKEN) {
    try {
      await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`);
      app.use(bot.webhookCallback('/webhook'));
      console.log('✅ Вебхук установлен!');
    } catch (err) { console.error(err); }
  }
});