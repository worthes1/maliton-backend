import express from 'express';
import { placeBet } from '../controllers/betController.js';

const router = express.Router();

// Пример эндпоинта для ставки
router.post('/bet', placeBet);

// Эндпоинт для получения баланса (заглушка)
router.get('/balance/:userId', (req, res) => {
  res.json({ balance: 1000, currency: 'RUB' });
});

export default router;