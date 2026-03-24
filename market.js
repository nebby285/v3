export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug required' });
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
