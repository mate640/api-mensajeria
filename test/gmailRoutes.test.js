const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const test = require("node:test");
const express = require("express");

const gmailRoutes = require("../routes/gmail");

async function startTestServer(t) {
  const app = express();
  app.use(express.json());
  app.use("/gmail", gmailRoutes);
  app.use((error, req, res, next) => {
    res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message
    });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function getText(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode,
          text: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    request.on("error", reject);
  });
}

test("sirve el administrador de cuentas Gmail", async (t) => {
  const base = await startTestServer(t);
  const response = await getText(`${base}/gmail/panel`);

  assert.equal(response.status, 200);
  assert.match(response.text, /Administrador de cuentas/);
  assert.match(response.text, /Vincular con Google/);
  assert.match(response.text, /Desvincular/);
});
