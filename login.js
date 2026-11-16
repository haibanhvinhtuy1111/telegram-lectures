// File: login.js
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const readline = require("readline");

const API_ID = 31512968;
const API_HASH = "562553a691db637e77ca86da3bf948bd";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

(async () => {
  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => (await ask("1. Nhập số điện thoại Telegram (VD: +84912345678): ")).trim(),
    phoneCode: async () => (await ask("2. Nhập mã OTP gồm 5 số gửi về app Telegram: ")).trim(),
    password: async () => (await ask("3. Nhập mật khẩu 2FA (nếu có): ")).trim(),
    onError: (err) => console.error("Lỗi:", err.message),
  });

  console.log("\n================ COPY CHUỖI DƯỚI ĐÂY ================");
  console.log(client.session.save());
  console.log("=====================================================\n");
  process.exit(0);
})();
