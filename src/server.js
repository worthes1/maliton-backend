import express from 'express';
import cors from 'cors';
import { Telegraf } from 'telegraf';
import mongoose from 'mongoose';

const app = express();
app.use(cors());
app.use(express.json());

// Берем данные из настроек Render
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
// 2. СОЗДАНИЕ СЧЕТА (ЗВЕЗДЫ)
// ==========================================
app.post('/api/create-invoice', async (req, res) => {
  const { telegramId, packageAmount, packagePriceInStars } = req.body;
  try {
    const invoiceLink = await bot.telegram.createInvoiceLink({
      title: `Пополнение на ${packageAmount} ₽`,
      description: `Пакет ${packagePriceInStars} звезд для Maliton`,
      payload: JSON.stringify({ userId: telegramId, amount: packageAmount }), 
      provider_token: '', // Для Stars всегда пустая строка
      currency: 'XTR',    // XTR = Telegram Stars
      prices: [{ label: 'Пакет звезд', amount: packagePriceInStars }], 
    });
    res.json({ invoiceLink });
  } catch (err) {
    console.error('Ошибка создания счета:', err);
    res.status(500).json({ error: 'Не удалось создать счет' });
  }
});

// ==========================================
// 3. ОБРАБОТЧИКИ ПЛАТЕЖЕЙ TELEGRAM
// ==========================================
// Вот тот самый важный обработчик! Он подтверждает оплату.
bot.on('pre_checkout_query', async (ctx) => {
  try { 
    await ctx.answerPreCheckoutQuery(true); 
  } catch (err) { 
    await ctx.answerPreCheckoutQuery(false, 'Ошибка валидации.'); 
  }
});

// Этот обработчик ловит успешную оплату и начисляет баланс
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
// 4. ЗАПУСК СЕРВЕРА И ВЕБХУКА
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
    } catch (err) { 
      console.error('❌ Ошибка вебхука:', err); 
    }
  }
});