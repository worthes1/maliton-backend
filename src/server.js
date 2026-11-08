import express from 'express';
import cors from 'cors';
import { Telegraf } from 'telegraf';
import mongoose from 'mongoose';

const app = express();
app.use(cors());
app.use(express.json());

const MY_TOKEN = process.env.BOT_TOKEN || '';
const MONGO_URI = process.env.MONGO_URI || '';
const ADMIN_ID = '5234247365'; // Твой ID

const bot = new Telegraf(MY_TOKEN);

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 60000 })
  .then(() => console.log('✅ База данных подключена!'))
  .catch(err => console.error('❌ Ошибка БД:', err.message));

// Схемы
const User = mongoose.model('User', new mongoose.Schema({
  telegramId: { type: String, unique: true, required: true },
  balance: { type: Number, default: 0 }
}));

const Withdrawal = mongoose.model('Withdrawal', new mongoose.Schema({
  telegramId: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { type: String, default: 'pending' },
  date: { type: Date, default: Date.now }
}));

const Match = mongoose.model('Match', new mongoose.Schema({
  tournament: { type: String, required: true },
  region: { type: String, default: 'CS2' },
  team1: { type: String, required: true },
  team2: { type: String, required: true },
  score1: { type: String, default: '' },
  score2: { type: String, default: '' },
  odds1: { type: Number, required: true },
  odds2: { type: Number, required: true },
  date: { type: Date, default: Date.now }
}));

// ==========================================
// 1. API ДЛЯ БАЛАНСА
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
// 2. API ДЛЯ ВЫВОДА
// ==========================================
app.post('/api/withdraw', async (req, res) => {
  const { telegramId, amount } = req.body;
  if (amount < 100) return res.status(400).json({ error: 'Минимальная сумма 100 ₽' });
  try {
    const user = await User.findOne({ telegramId });
    if (!user || user.balance < amount) return res.status(400).json({ error: 'Недостаточно средств' });
    user.balance -= amount;
    await user.save();
    await Withdrawal.create({ telegramId, amount });
    res.json({ balance: user.balance, message: 'Заявка создана' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 3. API ДЛЯ СПОРТА (МАТЧИ)
// ==========================================
app.get('/api/matches', async (req, res) => {
  try {
    const matches = await Match.find().sort({ date: -1 });
    res.json(matches);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/matches', async (req, res) => {
  const { telegramId, tournament, team1, team2, odds1, odds2 } = req.body;
  
  if (String(telegramId) !== ADMIN_ID) {
    return res.status(403).json({ error: 'Доступ запрещен: ваш ID не совпадает с ID админа' });
  }

  try {
    const newMatch = await Match.create({ 
      tournament, team1, team2, 
      odds1: Number(odds1), odds2: Number(odds2) 
    });
    res.json(newMatch);
  } catch (err) { 
    // Если база данных не смогла сохранить, показываем точную причину
    res.status(500).json({ error: `Ошибка базы данных: ${err.message}` }); 
  }
});

app.delete('/api/admin/matches/:id', async (req, res) => {
  const { telegramId } = req.body;
  if (String(telegramId) !== ADMIN_ID) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  try {
    await Match.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 4. ОПЛАТА ЗВЕЗДАМИ
// ==========================================
app.post('/api/create-invoice', async (req, res) => {
  const { telegramId, packageAmount, packagePriceInStars } = req.body;
  try {
    const invoiceLink = await bot.telegram.createInvoiceLink({
      title: `Пополнение на ${packageAmount} ₽`,
      description: `Пакет ${packagePriceInStars} звезд для Maliton`,
      payload: JSON.stringify({ userId: telegramId, amount: packageAmount }), 
      provider_token: '', 
      currency: 'XTR',    
      prices: [{ label: 'Пакет звезд', amount: packagePriceInStars }], 
    });
    res.json({ invoiceLink });
  } catch (err) { res.status(500).json({ error: 'Не удалось создать счет' }); }
});

bot.on('pre_checkout_query', async (ctx) => {
  try { await ctx.answerPreCheckoutQuery(true); } 
  catch (err) { await ctx.answerPreCheckoutQuery(false, 'Ошибка валидации.'); }
});

bot.on('message', async (ctx) => {
  if (!ctx.message.successful_payment) return;
  const payment = ctx.message.successful_payment;
  const payload = JSON.parse(payment.invoice_payload);
  try {
    const user = await User.findOne({ telegramId: payload.userId.toString() });
    if (user) { user.balance += payload.amount; await user.save(); }
    else { await User.create({ telegramId: payload.userId.toString(), balance: payload.amount }); }
    await ctx.reply(`✅ Оплата прошла! Зачислено ${payload.amount} ₽.`);
  } catch (err) { console.error(err); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL; 
  if (WEBHOOK_URL && MY_TOKEN) {
    try {
      await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`);
      app.use(bot.webhookCallback('/webhook'));
      console.log('✅ Вебхук установлен!');
    } catch (err) { console.error('❌ Ошибка вебхука:', err); }
  }
});