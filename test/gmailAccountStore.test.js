const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  GmailAccountStore,
  normalizeIdentification
} = require("../services/gmailAccountStore");

test("normaliza las identificaciones internas de Gmail", () => {
  assert.equal(normalizeIdentification(" administración "), "ADMINISTRACION");
  assert.equal(normalizeIdentification("Ventas CABA"), "VENTAS_CABA");
  assert.equal(normalizeIdentification("personal"), "PERSONAL");
});

test("guarda el refresh token cifrado y nunca lo expone al listar", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-gmail-store-")
  );
  const dataFile = path.join(temporaryRoot, "gmail-accounts.json");
  const store = new GmailAccountStore({
    dataFile,
    encryptionSecret: "una-clave-de-prueba-con-mas-de-32-caracteres"
  });

  t.after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  store.saveAuthorizedAccount({
    identification: "Ventas",
    email: "ventas@gmail.com",
    refreshToken: "refresh-token-super-secreto",
    scopes: ["email", "https://www.googleapis.com/auth/gmail.send"]
  });

  const rawFile = fs.readFileSync(dataFile, "utf8");
  assert.doesNotMatch(rawFile, /refresh-token-super-secreto/);
  assert.deepEqual(store.listAccounts()[0].identificacion, "VENTAS");
  assert.equal("refreshToken" in store.listAccounts()[0], false);
  assert.equal(
    store.getAuthorizedAccount("ventas").refreshToken,
    "refresh-token-super-secreto"
  );
});

test("impide asociar el mismo email a dos identificaciones", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-gmail-unique-")
  );
  const store = new GmailAccountStore({
    dataFile: path.join(temporaryRoot, "gmail-accounts.json"),
    encryptionSecret: "otra-clave-de-prueba-con-mas-de-32-caracteres"
  });

  t.after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  store.saveAuthorizedAccount({
    identification: "VENTAS",
    email: "empresa@gmail.com",
    refreshToken: "token-1"
  });

  assert.throws(
    () =>
      store.saveAuthorizedAccount({
        identification: "PERSONAL",
        email: "empresa@gmail.com",
        refreshToken: "token-2"
      }),
    (error) => error.statusCode === 409
  );
});

test("elimina una cuenta y recupera su token solo para revocarlo", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mensajeria-gmail-remove-")
  );
  const store = new GmailAccountStore({
    dataFile: path.join(temporaryRoot, "gmail-accounts.json"),
    encryptionSecret: "clave-para-eliminar-cuentas-con-32-caracteres"
  });

  t.after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  store.saveAuthorizedAccount({
    identification: "ADMINISTRACION",
    email: "administracion@gmail.com",
    refreshToken: "token-para-revocar"
  });

  const removed = store.removeAccount("administracion");

  assert.equal(removed.identificacion, "ADMINISTRACION");
  assert.equal(removed.refreshToken, "token-para-revocar");
  assert.deepEqual(store.listAccounts(), []);
  assert.throws(
    () => store.removeAccount("ADMINISTRACION"),
    (error) => error.statusCode === 404
  );
});
