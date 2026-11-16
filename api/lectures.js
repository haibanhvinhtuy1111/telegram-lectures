// GET /api/lectures           -> bài mới nhất
// GET /api/lectures?before=ID -> các bài cũ hơn ID
const CHANNEL = process.env.TG_CHANNEL || "spankbanggggg";

const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

module.exports = async (req, res) => {
  const before = Number(req.query.before) || 0;
  const url = `https://t.me/s/${CHANNEL}` + (before ? `?before=${before}` : "");

  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`Telegram trả về ${r.status}`);
    const html = await r.text();

    const blocks = html.split("tgme_widget_message_wrap").slice(1);
    const idOf = (b) => Number((b.match(/data-post="[^"\/]+\/(\d+)"/) || [])[1]);
    const allIds = blocks.map(idOf).filter(Boolean);

    const items = [];
    for (const b of blocks) {
      const id = idOf(b);
      if (!id || !b.includes("tgme_widget_message_video")) continue;

      const directUrl = (b.match(/<video[^>]+src="([^"]+)"/) || [])[1] || null;
      const thumb =
        (b.match(/tgme_widget_message_video_thumb[^>]+background-image:url\('([^']+)'\)/) || [])[1] ||
        null;

      const raw =
        (b.match(/class="tgme_widget_message_text js-message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/) ||
          [])[1] || "";
      const text = decode(raw.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "")).trim();

      items.push({
        id,
        title: text.split("\n")[0].slice(0, 120) || `Bài giảng ${id}`,
        text,
        duration: (b.match(/message_video_duration[^>]*>([^<]+)</) || [])[1] || "",
        date: (b.match(/<time[^>]*datetime="([^"]+)"/) || [])[1] || "",
        directUrl,
        streamUrl: `/api/stream?id=${id}`,
        thumb,
      });
    }
    items.reverse();

    const min = allIds.length ? Math.min(...allIds) : 0;
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({ channel: CHANNEL, items, next: min > 1 ? min : null });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
