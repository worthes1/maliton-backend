export function placeBet(req, res) {
  const { userId, matchId, outcome, amount } = req.body;

  if (!userId || !matchId || !outcome || !amount) {
    return res.status(400).json({ error: 'Не все поля заполнены' });
  }

  // Здесь должна быть логика списания денег и сохранения ставки в БД
  // Пока просто возвращаем успех
  console.log(`Ставка: user=${userId}, match=${matchId}, outcome=${outcome}, amount=${amount}`);

  res.json({
    success: true,
    message: 'Ставка принята',
    betId: Date.now(), // фейковый ID
  });
}