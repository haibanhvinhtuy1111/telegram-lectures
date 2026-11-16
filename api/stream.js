// GET /api/stream?id=4676 -> Stream trực tiếp video lớn từ Telegram
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const CHANNEL = process.env.TG_CHANNEL || "spankbanggggg";
const API_ID = Number(process.env.TG_API_ID);
const API_HASH = process.env.TG_API_HASH;
const SESSION_STR = process.env.TG_SESSION || "";

// Khối tải MTProto chuẩn (256 KB là ước số của 1 MB, không bao giờ gây lỗi OFFSET_INVALID)
const MTPROTO_PART_SIZE = 256 * 1024;
// Trả về tối đa 2 MB mỗi chunk để luôn an toàn dưới giới hạn 4.5 MB của Vercel
const MAX_CHUNK_SIZE = 2 * 1024 * 1024;

// Tái sử dụng kết nối và cache thông tin file giữa các lần gọi Serverless
globalThis.__tgMediaCache = globalThis.__tgMediaCache || new Map();

async function getClient() {
  if (!API_ID || !API_HASH || !SESSION_STR) {
    throw new Error("Thiếu biến môi trường TG_API_ID, TG_API_HASH hoặc TG_SESSION");
  }
  if (!globalThis.__tgClientPromise) {
    const client = new TelegramClient(new StringSession(SESSION_STR), API_ID, API_HASH, {
      connectionRetries: 3,
      useWSS: false,
    });
    globalThis.__tgClientPromise = client.connect().then(() => client);
  }
  return globalThis.__tgClientPromise;
}

async function getMediaInfo(client, msgId) {
  const cached = globalThis.__tgMediaCache.get(msgId);
  // Cache hiệu lực 10 phút để tua video nhanh mà không cần hỏi lại Telegram mỗi chunk
  if (cached && Date.now() - cached.time < 10 * 60 * 1000) {
    return cached;
  }
  const [msg] = await client.getMessages(CHANNEL, { ids: [msgId] });
  const doc = msg?.media?.document;
  if (!doc) return null;

  const info = {
    media: msg.media,
    size: Number(doc.size),
    mimeType: doc.mimeType || "video/mp4",
    time: Date.now(),
  };
  globalThis.__tgMediaCache.set(msgId, info);
  return info;
}

module.exports = async (req, res) => {
  const msgId = Number(req.query.id);
  if (!msgId) return res.status(400).end("Missing video id");

  try {
    const client = await getClient();
    const info = await getMediaInfo(client, msgId);
    if (!info) return res.status(404).end("Video not found");

    const fileSize = info.size;
    const range = req.headers.range;

    let reqStart = 0;
    let reqEnd = Math.min(MAX_CHUNK_SIZE - 1, fileSize - 1);

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      reqStart = parseInt(parts[0], 10) || 0;
      reqEnd = parts[1]
        ? Math.min(parseInt(parts[1], 10), reqStart + MAX_CHUNK_SIZE - 1, fileSize - 1)
        : Math.min(reqStart + MAX_CHUNK_SIZE - 1, fileSize - 1);
    }

    if (reqStart >= fileSize) {
      res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
      return res.end();
    }

    const desiredLength = reqEnd - reqStart + 1;

    // Căn chỉnh điểm bắt đầu tải xuống theo bội số 256 KB của MTProto
    const alignedStart = Math.floor(reqStart / MTPROTO_PART_SIZE) * MTPROTO_PART_SIZE;
    const skipBytes = reqStart - alignedStart;
    const bytesToFetch = skipBytes + desiredLength;

    const chunks = [];
    let fetched = 0;

    for await (const chunk of client.iterDownload({
      file: info.media,
      offset: BigInt(alignedStart),
      requestSize: MTPROTO_PART_SIZE,
    })) {
      chunks.push(chunk);
      fetched += chunk.length;
      if (fetched >= bytesToFetch) break;
    }

    // Cắt chính xác từ byte trình duyệt yêu cầu
    const fullBuffer = Buffer.concat(chunks);
    const slice = fullBuffer.subarray(skipBytes, skipBytes + desiredLength);
    const actualEnd = reqStart + slice.length - 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${reqStart}-${actualEnd}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": slice.length,
      "Content-Type": info.mimeType,
      "Cache-Control": "public, max-age=3600",
    });
    res.end(slice);
  } catch (e) {
    // Nếu file_reference hết hạn thì xóa cache để lần gọi sau lấy lại
    globalThis.__tgMediaCache.delete(msgId);
    res.status(500).json({ error: String(e.message || e) });
  }
};
