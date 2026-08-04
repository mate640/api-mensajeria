const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const express = require("express");

process.env.WHATSAPP_MULTI_INSTANCE_ENABLED = "false";

const whatsappRoutes = require("../routes/whatsapp");

async function startTestServer(t) {
  const app = express();
  app.use(express.json());
  app.use("/whatsapp", whatsappRoutes);
  app.use((error, req, res, next) => {
    res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message
    });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("mantiene el contrato de estado legado cuando la bandera esta apagada", async (t) => {
  const base = await startTestServer(t);
  const mode = await fetch(`${base}/whatsapp/modo`).then((response) =>
    response.json()
  );
  const response = await fetch(`${base}/whatsapp/estado`);
  const status = await response.json();

  assert.equal(mode.modo, "legacy");
  assert.equal(response.status, 200);
  assert.equal(status.ok, true);
  assert.equal(typeof status.estado, "string");
  assert.equal("instancias" in status, false);
});

test("no exige instancia al endpoint legado", async (t) => {
  const base = await startTestServer(t);
  const response = await fetch(`${base}/whatsapp/enviar-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      destinos: [{ numero: "5491112345678", nombre: "Prueba" }],
      mensaje: "Este mensaje no se envia porque el socket de prueba esta cerrado"
    })
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.doesNotMatch(body.error, /instancia es obligatoria/);
});
