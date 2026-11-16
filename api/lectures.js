// File: api/lectures.js
// GET /api/lectures                  -> Lấy đợt bài mới nhất (gom 5 trang/lần)
// GET /api/lectures?before=ID        -> Lấy tiếp các đợt bài cũ hơn ID
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

function parsePage(html) {
  const blocks = html.split("tgme_widget_message_wrap").slice(1);
  const idOf = (b) => Number((b.match(/data-post="[^"\/]+\/(\d+)"/) || [])[1]);
  const allIds = blocks.map(idOf).filter(Boolean);

  const pageItems = [];
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

    pageItems.push({
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

  pageItems.reverse(); // Mới nhất lên đầu
  const minId = allIds.length ? Math.min(...allIds) : 0;
  return { pageItems, minId };
}

module.exports = async (req, res) => {
  let cursor = Number(req.query.before) || 0;
  // Mặc định gom 5 trang mỗi request để tải toàn bộ kênh nhanh gấp 5 lần
  const pagesToFetch = Math.min(Math.max(Number(req.query.pages) || 5, 1), 8);

  const seenIds = new Set();
  const items = [];

  try {
    for (let i = 0; i < pagesToFetch; i++) {
      const url = `https://t.me/s/${CHANNEL}` + (cursor ? `?before=${cursor}` : "");
      const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
      if (!r.ok) {
        if (items.length > 0) break;
        throw new Error(`Telegram trả về ${r.status}`);
      }

      const html = await r.text();
      const { pageItems, minId } = parsePage(html);

      for (const item of pageItems) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          items.push(item);
        }
      }

      if (!minId || minId <= 1 || (cursor && minId >= cursor)) {
        cursor = 0;
        break;
      }
      cursor = minId;
    }

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({
      channel: CHANNEL,
      items,
      next: cursor > 1 ? cursor : null,
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
