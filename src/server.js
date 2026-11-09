import express from 'express';
import cors from 'cors';
import { Telegraf } from 'telegraf';
import mongoose from 'mongoose';

const app = express();
app.use(cors());
app.use(express.json());

const MY_TOKEN = process.env.BOT_TOKEN || '';
const MONGO_URI = process.env.MONGO_URI || '';
const SUPER_ADMIN_ID = '5234247365'; // Твой главный ID

const bot = new Telegraf(MY_TOKEN);

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 60000 })
  .then(async () => {
    console.log('✅ База данных подключена!');
    // Автоматически создаем Главного админа при запуске, если его нет
    const superAdmin = await Admin.findOne({ telegramId: SUPER_ADMIN_ID });
    if (!superAdmin) {
      await Admin.create({ telegramId: SUPER_ADMIN_ID, role: 'super' });
      console.log('👑 Главный администратор добавлен в базу.');
    }
  })
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
  markets: [{ 
    group: { type: String, default: 'Основные' }, 
    name: { type: String, required: true },      
    odds: { type: Number, required: true }       
  }],
  date: { type: Date, default: Date.now },
  isLive: { type: Boolean, default: false },
  isClosed: { type: Boolean, default: false }
}));

// НОВАЯ Схема Администраторов
const Admin = mongoose.model('Admin', new mongoose.Schema({
  telegramId: { type: String, unique: true, required: true },
  role: { type: String, enum: ['super', 'regular'], default: 'regular' }
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
// 3. API ДЛЯ УПРАВЛЕНИЯ АДМИНАМИ
// ==========================================
// Проверка, является ли пользователь админом (для фронтенда)
app.get('/api/admin/check/:id', async (req, res) => {
  try {
    const admin = await Admin.findOne({ telegramId: req.params.id });
    res.json({ isAdmin: !!admin, role: admin ? admin.role : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Получить список всех админов (только Гл. Админ)
app.get('/api/admin/list', async (req, res) => {
  if (String(req.query.telegramId) !== SUPER_ADMIN_ID) return res.status(403).json({ error: 'Доступ запрещен' });
  try {
    const admins = await Admin.find();
    res.json(admins);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Добавить нового админа (только Гл. Админ)
app.post('/api/admin/add', async (req, res) => {
  const { telegramId, newAdminId, role } = req.body;
  if (String(telegramId) !== SUPER_ADMIN_ID) return res.status(403).json({ error: 'Доступ запрещен' });
  
  if (newAdminId === SUPER_ADMIN_ID) return res.status(400).json({ error: 'Этот ID уже Гл. Админ' });

  try {
    const exists = await Admin.findOne({ telegramId: newAdminId });
    if (exists) return res.status(400).json({ error: 'Этот ID уже админ' });
    
    const newAdmin = await Admin.create({ telegramId: newAdminId, role: role || 'regular' });
    res.json(newAdmin);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Удалить админа (только Гл. Админ)
app.delete('/api/admin/:id', async (req, res) => {
  const { telegramId } = req.body;
  if (String(telegramId) !== SUPER_ADMIN_ID) return res.status(403).json({ error: 'Доступ запрещен' });
  if (req.params.id === SUPER_ADMIN_ID) return res.status(400).json({ error: 'Нельзя удалить Гл. Админа' });

  try {
    await Admin.deleteOne({ telegramId: req.params.id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ==========================================
// 4. API ДЛЯ МАТЧЕЙ (Требует прав Админа)
// ==========================================
const checkAdmin = async (req, res, next) => {
  const id = req.body.telegramId || req.query.telegramId;
  if (!id) return res.status(401).json({ error: 'Нет ID' });
  const admin = await Admin.findOne({ telegramId: String(id) });
  if (!admin) return res.status(403).json({ error: 'Вы не администратор' });
  next();
};

app.get('/api/matches', async (req, res) => {
  try {
    const matches = await Match.find().sort({ date: -1 });
    res.json(matches);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/matches', checkAdmin, async (req, res) => {
  const { tournament, region, team1, team2, markets, date, isLive, isClosed } = req.body;
  try {
    const newMatch = await Match.create({ 
      tournament, region, team1, team2, markets,
      date: date ? new Date(date) : new Date(),
      isLive: Boolean(isLive), isClosed: Boolean(isClosed)
    });
    res.json(newMatch);
  } catch (err) { res.status(500).json({ error: `Ошибка БД: ${err.message}` }); }
});

app.put('/api/admin/matches/:id', checkAdmin, async (req, res) => {
  const { tournament, region, team1, team2, markets, date, isLive, isClosed } = req.body;
  try {
    const updatedMatch = await Match.findByIdAndUpdate(req.params.id, { 
      tournament, region, team1, team2, markets,
      date: date ? new Date(date) : new Date(),
      isLive: Boolean(isLive), isClosed: Boolean(isClosed)
    }, { new: true });
    res.json(updatedMatch);
  } catch (err) { res.status(500).json({ error: `Ошибка обновления: ${err.message}` }); }
});

app.delete('/api/admin/matches/:id', checkAdmin, async (req, res) => {
  try {
    await Match.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 5. ОПЛАТА ЗВЕЗДАМИ
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