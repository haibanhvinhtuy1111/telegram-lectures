// File: api/stream.js
// GET /api/stream?id=4673 -> Stream trực tiếp video lớn qua MTProto (Chống crash 500)

// Chặn các lỗi ngầm của socket GramJS làm sập tiến trình Node.js trên Vercel
if (!globalThis.__tgErrorShield) {
  globalThis.__tgErrorShield = true;
  process.on("unhandledRejection", (err) => {
    console.error("GramJS unhandledRejection:", err?.message || err);
  });
}

const CHANNEL = process.env.TG_CHANNEL || "spankbanggggg";
const API_ID = Number(process.env.TG_API_ID) || 31512968;
const API_HASH = process.env.TG_API_HASH || "562553a691db637e77ca86da3bf948bd";
const SESSION_STR = (
  process.env.TG_SESSION ||
  "1BQANOTEuMTA4LjU2LjE4NgG7XBr/db36p5RLigAzRdLxaLh3PWBOyvFIGDGr/nxEp8Hyo0Bs1wMvpdmOVYn1D6Dg6VTShd6VMpy34KL4GJWiGeqHr0+tTtHux4gWxPAHsbKTR23wRhLTm0A9j6CftexKZJUQHtrD4q87SpqXrlwRXBeLKu04zcxcQC7LdNDrPsHCiVZuEs/BpAqyLuRhcEbu5ekK+4rmMI3u74jmRm1/vSMpGng+Fn1OrNKROu8PNq6kcKIGfYPr6d4l1R1BDs2ymVkH11pA1mCUjd4XspNcrD1KnL2BSoixD8tI5WXS8KiHPeeNGsq8mWjQaJzdu3UFXcJ4BKIt/qMVZj5ugv4zEQ=="
).trim();

const PART_SIZE = 512 * 1024; // 512 KB chuẩn MTProto

globalThis.__tgMediaCache = globalThis.__tgMediaCache || new Map();
globalThis.__tgQueue = globalThis.__tgQueue || Promise.resolve();

// Hàng đợi tuần tự giúp 2 request đầu/cuối video của trình duyệt không tranh chấp kết nối DC
function runSerialized(fn) {
  const next = globalThis.__tgQueue.then(fn, fn);
  globalThis.__tgQueue = next.catch(() => {});
  return next;
}

function loadTelegramSdk() {
  try {
    const { TelegramClient } = require("telegram");
    const { StringSession } = require("telegram/sessions");
    return { TelegramClient, StringSession };
  } catch (err) {
    throw new Error(
      "Vercel chưa cài thư viện 'telegram'. Hãy kiểm tra file package.json đã đặt ở thư mục gốc (ngoài thư mục api) chưa. Chi tiết: " +
        err.message
    );
  }
}

async function getClient() {
  const { TelegramClient, StringSession } = loadTelegramSdk();

  if (!globalThis.__tgClientPromise) {
    globalThis.__tgClientPromise = (async () => {
      const client = new TelegramClient(new StringSession(SESSION_STR), API_ID, API_HASH, {
        connectionRetries: 3,
        useWSS: false,
      });
      await client.connect();
      return client;
    })().catch((err) => {
      globalThis.__tgClientPromise = null;
      throw err;
    });
  }

  const client = await globalThis.__tgClientPromise;
  if (!client.connected) {
    await client.connect();
  }
  return client;
}

async function getMediaInfo(client, msgId, forceRefresh = false) {
  const cached = globalThis.__tgMediaCache.get(msgId);
  if (!forceRefresh && cached && Date.now() - cached.time < 10 * 60 * 1000) {
    return cached;
  }

  const msgs = await client.getMessages(CHANNEL, { ids: [msgId] });
  const msg = msgs && msgs[0];
  const doc = msg?.media?.document;
  if (!doc) return null;

  // Dùng chính đối tượng BigInteger có sẵn của doc.size để tạo offset chuẩn xác
  const zeroBigInt = doc.size.multiply(0);

  const info = {
    media: msg.media,
    size: Number(doc.size),
    zeroBigInt,
    mimeType: doc.mimeType || "video/mp4",
    time: Date.now(),
  };
  globalThis.__tgMediaCache.set(msgId, info);
  return info;
}

async function fetchParts(client, info, alignedStart, partsCount) {
  const chunks = [];
  const offsetBigInt = info.zeroBigInt.add(alignedStart);

  for await (const chunk of client.iterDownload({
    file: info.media,
    offset: offsetBigInt,
    requestSize: PART_SIZE,
    limit: partsCount,
  })) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  const msgId = Number(req.query.id);
  if (!msgId) return res.status(400).json({ error: "Thiếu id bài giảng" });

  try {
    await runSerialized(async () => {
      const client = await getClient();
      let info = await getMediaInfo(client, msgId);
      if (!info) {
        res.status(404).json({ error: "Không tìm thấy video trong bài #" + msgId });
        return;
      }

      const fileSize = info.size;

      if (req.method === "HEAD") {
        res.writeHead(200, {
          "Accept-Ranges": "bytes",
          "Content-Length": fileSize,
          "Content-Type": info.mimeType,
        });
        res.end();
        return;
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
          explicitEnd = Math.min(parseInt(parts[1], 10), fileSize - 1);
        }
      }

      if (reqStart >= fileSize || reqStart < 0) {
        res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
        res.end();
        return;
      }

      const alignedStart = Math.floor(reqStart / PART_SIZE) * PART_SIZE;
      const skipBytes = reqStart - alignedStart;

      // Tải 2 khối (1 MB) nếu ở đầu video hoặc sát mép khối 512 KB
      const needTwoParts =
        (reqStart === 0 || PART_SIZE - skipBytes < 128 * 1024) &&
        alignedStart + PART_SIZE < fileSize;
      const partsCount = needTwoParts ? 2 : 1;

      let rawBuffer;
      try {
        rawBuffer = await fetchParts(client, info, alignedStart, partsCount);
      } catch (err) {
        if (String(err.errorMessage || err.message || "").includes("FILE_REFERENCE")) {
          info = await getMediaInfo(client, msgId, true);
          rawBuffer = await fetchParts(client, info, alignedStart, partsCount);
        } else {
          throw err;
        }
      }

      if (!rawBuffer || !rawBuffer.length) {
        throw new Error("Không nhận được dữ liệu từ Telegram");
      }

      const maxAvailableEnd = alignedStart + rawBuffer.length - 1;
      const reqEnd = hasExplicitEnd ? Math.min(explicitEnd, maxAvailableEnd) : maxAvailableEnd;
      const takeBytes = Math.max(0, reqEnd - reqStart + 1);
      const slice = rawBuffer.subarray(skipBytes, skipBytes + takeBytes);
      const actualEnd = reqStart + slice.length - 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${reqStart}-${actualEnd}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": slice.length,
        "Content-Type": info.mimeType,
        "Cache-Control": "public, max-age=3600",
      });
      res.end(slice);
    });
  } catch (e) {
    globalThis.__tgMediaCache.delete(msgId);
    if (!res.headersSent) {
      res.status(500).json({ error: String(e.errorMessage || e.message || e) });
    }
  }
};
