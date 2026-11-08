import express from 'express';
import cors from 'cors';
import { Telegraf } from 'telegraf';
import mongoose from 'mongoose';

const app = express();
app.use(cors());
app.use(express.json());

const MY_TOKEN = process.env.BOT_TOKEN || '';
const MONGO_URI = process.env.MONGO_URI || '';

const bot = new Telegraf(MY_TOKEN);

// Подключение к БД
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 60000 })
  .then(() => console.log('✅ База данных подключена!'))
  .catch(err => console.error('❌ Ошибка БД:', err.message));

// Схема пользователя
const User = mongoose.model('User', new mongoose.Schema({
  telegramId: { type: String, unique: true, required: true },
  balance: { type: Number, default: 1000 }
}));

// НОВАЯ Схема для заявок на вывод
const Withdrawal = mongoose.model('Withdrawal', new mongoose.Schema({
  telegramId: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { type: String, default: 'pending' }, // pending, approved, rejected
  date: { type: Date, default: Date.now }
}));

// ==========================================
// 1. API ДЛЯ БАЛАНСА
// ==========================================
app.get('/api/user/:id', async (req, res) => {
  try {
    let user = await User.findOne({ telegramId: req.params.id });
    if (!user) {
      user = await User.create({ telegramId: req.params.id, balance: 1000 });
    }
    res.json({ balance: user.balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/balance', async (req, res) => {
  const { telegramId, newBalance } = req.body;
  try {
    const user = await User.findOneAndUpdate(
      { telegramId },
      { balance: newBalance },
      { new: true, upsert: true }
    );
    res.json({ balance: user.balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. НОВЫЙ API ДЛЯ ВЫВОДА СРЕДСТВ
// ==========================================
app.post('/api/withdraw', async (req, res) => {
  const { telegramId, amount } = req.body;
  
  if (amount < 100) {
    return res.status(400).json({ error: 'Минимальная сумма вывода — 100 ₽' });
  }

  try {
    const user = await User.findOne({ telegramId });
    if (!user || user.balance < amount) {
      return res.status(400).json({ error: 'Недостаточно средств на балансе' });
    }

    // Списываем баланс
    user.balance -= amount;
    await user.save();

    // Создаем заявку
    await Withdrawal.create({ telegramId, amount });

    res.json({ balance: user.balance, message: 'Заявка на вывод создана' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. СОЗДАНИЕ СЧЕТА НА ОПЛАТУ ЗВЕЗДАМИ
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
  } catch (err) {
    console.error('Ошибка создания счета:', err);
    res.status(500).json({ error: 'Не удалось создать счет' });
  }
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
    if (user) {
      user.balance += payload.amount;
      await user.save();
    } else {
      await User.create({ telegramId: payload.userId.toString(), balance: payload.amount });
    }
    await ctx.reply(`✅ Оплата прошла успешно! Зачислено ${payload.amount} ₽.`);
  } catch (err) {
    console.error('Ошибка при начислении баланса:', err);
  }
});

// ==========================================
// 4. ЗАПУСК
// ==========================================
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