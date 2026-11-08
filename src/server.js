import express from 'express';
import cors from 'cors';
import { Telegraf } from 'telegraf';

const app = express();
app.use(cors());
app.use(express.json());

// ❗ Лучше вынести токен в переменные окружения Render, но для теста можно оставить так
const MY_TOKEN = '7216491350:AAFZefMBAfDQGQITZKHKY_P7QtLqu-SlwmA'; 

const bot = new Telegraf(MY_TOKEN);

// ==========================================
// 1. ЭНДПОИНТ ДЛЯ СОЗДАНИЯ СЧЕТА (ЗВЕЗДЫ)
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

// ==========================================
// 2. ОБРАБОТЧИКИ ОПЛАТЫ В БОТЕ
// ==========================================
bot.on('pre_checkout_query', async (ctx) => {
  try {
    await ctx.answerPreCheckoutQuery(true); 
  } catch (err) {
    await ctx.answerPreCheckoutQuery(false, 'Ошибка валидации.');
  }
});

bot.on('message', async (ctx) => {
  if (!ctx.message.successful_payment) return;

  const payment = ctx.message.successful_payment;
  const payload = JSON.parse(payment.invoice_payload);
  
  console.log(`Пользователь ${payload.userId} пополнил баланс на ${payload.amount} ₽`);
  await ctx.reply(`✅ Оплата прошла успешно! Зачислено ${payload.amount} ₽.`);
});

// ==========================================
// 3. ЗАПУСК СЕРВЕРА И ВЕБХУКА
// ==========================================
const PORT = process.env.PORT || 5000;

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  
  // Устанавливаем вебхук для Telegram
  // Render автоматически выдаст твоему сервису HTTPS-ссылку (например, https://maliton-backend.onrender.com)
  // ВАЖНО: Эту ссылку мы узнаем на Шаге 3, а пока оставь плейсхолдер.
  const WEBHOOK_URL = 'https://maliton-backend-1.onrender.com'; 
  
  try {
    await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`);
    app.use(bot.webhookCallback('/webhook'));
    console.log('✅ Вебхук успешно установлен!');
  } catch (err) {
    console.error('❌ Ошибка установки вебхука:', err);
  }
});