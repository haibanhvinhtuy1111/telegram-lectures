// File: api/stream.js
// GET /api/stream?id=4676 -> Stream trực tiếp video dung lượng lớn từ Telegram
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

let bigInt;
try {
  bigInt = require("big-integer");
} catch {
  bigInt = require("telegram/node_modules/big-integer");
}

const CHANNEL = process.env.TG_CHANNEL || "spankbanggggg";
const API_ID = Number(process.env.TG_API_ID) || 31512968;
const API_HASH = process.env.TG_API_HASH || "562553a691db637e77ca86da3bf948bd";
const SESSION_STR =
  process.env.TG_SESSION ||
  "1BQANOTEuMTA4LjU2LjE4NgG7XBr/db36p5RLigAzRdLxaLh3PWBOyvFIGDGr/nxEp8Hyo0Bs1wMvpdmOVYn1D6Dg6VTShd6VMpy34KL4GJWiGeqHr0+tTtHux4gWxPAHsbKTR23wRhLTm0A9j6CftexKZJUQHtrD4q87SpqXrlwRXBeLKu04zcxcQC7LdNDrPsHCiVZuEs/BpAqyLuRhcEbu5ekK+4rmMI3u74jmRm1/vSMpGng+Fn1OrNKROu8PNq6kcKIGfYPr6d4l1R1BDs2ymVkH11pA1mCUjd4XspNcrD1KnL2BSoixD8tI5WXS8KiHPeeNGsq8mWjQaJzdu3UFXcJ4BKIt/qMVZj5ugv4zEQ==";

// Kích thước khối chuẩn của MTProto (512 KB = 1 lần gọi duy nhất cho mỗi HTTP Range request)
const BLOCK_SIZE = 512 * 1024;

globalThis.__tgMediaCache = globalThis.__tgMediaCache || new Map();

async function getClient() {
  if (globalThis.__tgClient) {
    if (!globalThis.__tgClient.connected) {
      await globalThis.__tgClient.connect();
    }
    return globalThis.__tgClient;
  }

  if (!globalThis.__tgClientPromise) {
    const client = new TelegramClient(new StringSession(SESSION_STR), API_ID, API_HASH, {
      connectionRetries: 3,
      useWSS: false,
    });
    globalThis.__tgClientPromise = client
      .connect()
      .then(() => {
        globalThis.__tgClient = client;
        return client;
      })
      .catch((err) => {
        globalThis.__tgClientPromise = null;
        throw err;
      });
  }
  return globalThis.__tgClientPromise;
}

async function getMediaInfo(client, msgId) {
  const cached = globalThis.__tgMediaCache.get(msgId);
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
  if (!msgId) return res.status(400).json({ error: "Thiếu id bài giảng" });

  try {
    const client = await getClient();
    const info = await getMediaInfo(client, msgId);
    if (!info) return res.status(404).json({ error: "Không tìm thấy video" });

    const fileSize = info.size;

    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Accept-Ranges": "bytes",
        "Content-Length": fileSize,
        "Content-Type": info.mimeType,
      });
      return res.end();
    }

    const range = req.headers.range;
    let reqStart = 0;
    let hasExplicitEnd = false;
    let explicitEnd = fileSize - 1;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      reqStart = parseInt(parts[0], 10) || 0;
      if (parts[1]) {
        hasExplicitEnd = true;
        explicitEnd = parseInt(parts[1], 10);
      }
    }

    if (reqStart >= fileSize) {
      res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
      return res.end();
    }

    // Căn chỉnh về đầu khối 512 KB gần nhất của MTProto
    const alignedStart = Math.floor(reqStart / BLOCK_SIZE) * BLOCK_SIZE;
    const blockEnd = Math.min(alignedStart + BLOCK_SIZE - 1, fileSize - 1);
    const reqEnd = hasExplicitEnd ? Math.min(explicitEnd, blockEnd) : blockEnd;

    const skipBytes = reqStart - alignedStart;
    const takeBytes = reqEnd - reqStart + 1;

    let rawChunk = Buffer.alloc(0);
    for await (const chunk of client.iterDownload({
      file: info.media,
      offset: bigInt(alignedStart),
      requestSize: BLOCK_SIZE,
      limit: 1,
      fileSize,
    })) {
      rawChunk = Buffer.from(chunk);
      break;
    }

    if (!rawChunk.length) {
      throw new Error("Không nhận được dữ liệu từ Telegram");
    }

    const slice = rawChunk.subarray(skipBytes, skipBytes + takeBytes);
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
    globalThis.__tgMediaCache.delete(msgId);
    res.status(500).json({ error: String(e.message || e) });
  }
};
