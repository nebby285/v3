export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { token_id } = req.query;
  if (!token_id) return res.status(400).json({ error: 'token_id required' });
  try {
    const [buyRes, sellRes] = await Promise.all([
      fetch(`https://clob.polymarket.com/price?token_id=${token_id}&side=BUY`, { headers: { 'User-Agent': 'Mozilla/5.0' } }),
      fetch(`https://clob.polymarket.com/price?token_id=${token_id}&side=SELL`, { headers: { 'User-Agent': 'Mozilla/5.0' } }),
    ]);
    const [buy, sell] = await Promise.all([buyRes.json(), sellRes.json()]);
    res.status(200).json({ buy, sell });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
