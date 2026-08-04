const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { GmailAccountStore } = require("../services/gmailAccountStore");
const { GmailService } = require("../services/gmailService");

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data)
  };
}

test("envia usando la cuenta elegida por identificacion y devuelve IDs", async (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-gmail-service-")
  );
  const store = new GmailAccountStore({
    dataFile: path.join(temporaryRoot, "gmail-accounts.json"),
    encryptionSecret: "clave-de-cifrado-de-prueba-con-32-caracteres"
  });
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });

    if (url.includes("oauth2.googleapis.com/token")) {
      return jsonResponse({
        access_token: "access-token",
        expires_in: 3600
      });
    }

    return jsonResponse({
      id: "gmail-message-123",
      threadId: "gmail-thread-456"
    });
  };
  const service = new GmailService({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:3002/gmail/oauth/callback",
    stateSecret: "secreto-de-state-de-prueba-con-32-caracteres",
    store,
    fetchImpl
  });

  t.after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  store.saveAuthorizedAccount({
    identification: "VENTAS",
    email: "ventas@gmail.com",
    refreshToken: "refresh-token"
  });

  const result = await service.sendEmail({
    identificacion: "ventas",
    para: "cliente@example.com",
    asunto: "Consulta",
    texto: "Hola"
  });

  assert.equal(result.identificacion, "VENTAS");
  assert.equal(result.cuenta, "ventas@gmail.com");
  assert.equal(result.gmailMessageId, "gmail-message-123");
  assert.equal(result.gmailThreadId, "gmail-thread-456");
  assert.match(result.rfcMessageId, /^<.+@gmail\.com>$/);

  const gmailRequest = requests.find((request) =>
    request.url.includes("gmail.googleapis.com")
  );
  const body = JSON.parse(gmailRequest.options.body);
  const mime = Buffer.from(body.raw, "base64url").toString("utf8");

  assert.match(mime, /From: ventas@gmail\.com/);
  assert.match(mime, /To: cliente@example\.com/);
  assert.equal(gmailRequest.options.headers.Authorization, "Bearer access-token");
});

test("la baja elimina la cuenta y revoca su refresh token en Google", async (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-gmail-revoke-")
  );
  const store = new GmailAccountStore({
    dataFile: path.join(temporaryRoot, "gmail-accounts.json"),
    encryptionSecret: "clave-de-revocacion-de-prueba-con-32-caracteres"
  });
  const requests = [];
  const service = new GmailService({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:3002/gmail/oauth/callback",
    stateSecret: "secreto-de-state-de-prueba-con-32-caracteres",
    store,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => ""
      };
    }
  });

  t.after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  store.saveAuthorizedAccount({
    identification: "PERSONAL",
    email: "personal@gmail.com",
    refreshToken: "refresh-token-personal"
  });

  const result = await service.removeAccount("personal");

  assert.equal(result.eliminada, true);
  assert.equal(result.revocadaEnGoogle, true);
  assert.deepEqual(store.listAccounts(), []);
  assert.equal(requests[0].url, "https://oauth2.googleapis.com/revoke");
  assert.match(String(requests[0].options.body), /refresh-token-personal/);
});
