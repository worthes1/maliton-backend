import express from 'express';
import cors from 'cors';
import { Telegraf } from 'telegraf';
import mongoose from 'mongoose';

const app = express();
app.use(cors());
app.use(express.json());

const MY_TOKEN = process.env.BOT_TOKEN || '';
const MONGO_URI = process.env.MONGO_URI || '';
const SUPER_ADMIN_ID = '5234247365';

const bot = new Telegraf(MY_TOKEN);

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 60000 })
  .then(async () => {
    console.log('✅ База данных подключена!');
    const superAdmin = await Admin.findOne({ telegramId: SUPER_ADMIN_ID });
    if (!superAdmin) {
      await Admin.create({ telegramId: SUPER_ADMIN_ID, role: 'super' });
    }
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
  tournament: { type: String, required: true },
  region: { type: String, default: 'CS2' },
  team1: { type: String, required: true },
  team2: { type: String, required: true },
  markets: [{ group: String, name: String, odds: Number }],
  date: { type: Date, default: Date.now },
  isLive: { type: Boolean, default: false },
  isClosed: { type: Boolean, default: false }
}));

// НОВАЯ Схема: Ставки
const Bet = mongoose.model('Bet', new mongoose.Schema({
  telegramId: { type: String, required: true },
  matchName: { type: String, required: true },
  market: { type: String, required: true },
  odd: { type: Number, required: true },
  stake: { type: Number, required: true },
  potentialWin: { type: Number, required: true },
  status: { type: String, default: 'pending' }, // pending, win, lose
  date: { type: Date, default: Date.now }
}));

// НОВАЯ Схема: Транзакции (Пополнения и Выводы)
const Transaction = mongoose.model('Transaction', new mongoose.Schema({
  telegramId: { type: String, required: true },
  type: { type: String, required: true }, // deposit, withdraw
  amount: { type: Number, required: true },
  status: { type: String, default: 'success' },
  date: { type: Date, default: Date.now }
}));

// ==========================================
// API ДЛЯ БАЛАНСА
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

// ==========================================
// API ДЛЯ СТАВОК
// ==========================================
app.post('/api/bets', async (req, res) => {
  const { telegramId, matchName, market, odd, stake, potentialWin } = req.body;
  try {
    const user = await User.findOne({ telegramId });
    if (!user || user.balance < stake) return res.status(400).json({ error: 'Недостаточно средств' });

    user.balance -= stake;
    await user.save();

    const newBet = await Bet.create({ telegramId, matchName, market, odd, stake, potentialWin });
    res.json({ success: true, balance: user.balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bets/:id', async (req, res) => {
  try {
    const bets = await Bet.find({ telegramId: req.params.id }).sort({ date: -1 });
    res.json(bets);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// API ДЛЯ ИСТОРИИ ПЛАТЕЖЕЙ
// ==========================================
app.get('/api/transactions/:id', async (req, res) => {
  try {
    const trans = await Transaction.find({ telegramId: req.params.id }).sort({ date: -1 });
    res.json(trans);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ВЫВОД
app.post('/api/withdraw', async (req, res) => {
  const { telegramId, amount } = req.body;
  if (amount < 100) return res.status(400).json({ error: 'Минимальная сумма 100 ₽' });
  try {
    const user = await User.findOne({ telegramId });
    if (!user || user.balance < amount) return res.status(400).json({ error: 'Недостаточно средств' });
    
    user.balance -= amount;
    await user.save();
    
    await Transaction.create({ telegramId, type: 'withdraw', amount, status: 'pending' });
    res.json({ balance: user.balance, message: 'Заявка создана' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// API ДЛЯ АДМИНОВ
// ==========================================
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

// ==========================================
// API ДЛЯ МАТЧЕЙ
// ==========================================
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

// ==========================================
// ОПЛАТА ЗВЕЗДАМИ
// ==========================================
app.post('/api/create-invoice', async (req, res) => {
  const { telegramId, packageAmount, packagePriceInStars } = req.body;
  try {
    const invoiceLink = await bot.telegram.createInvoiceLink({
      title: `Пополнение на ${packageAmount} ₽`,
      description: `Пакет ${packagePriceInStars} звезд`,
      payload: JSON.stringify({ userId: telegramId, amount: packageAmount }), 
      provider_token: '', currency: 'XTR',    
      prices: [{ label: 'Пакет звезд', amount: packagePriceInStars }], 
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
    
    // Записываем транзакцию
    await Transaction.create({ telegramId: payload.userId.toString(), type: 'deposit', amount: payload.amount });
    await ctx.reply(`✅ Зачислено ${payload.amount} ₽.`);
  } catch (err) { console.error(err); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', async () => {
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