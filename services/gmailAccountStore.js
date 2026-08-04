const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeIdentification(value) {
  const identification = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!identification || identification.length > 50) {
    throw httpError(
      "identificacion debe contener letras o numeros y tener hasta 50 caracteres",
      400
    );
  }

  return identification;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError("Google no devolvio una direccion de email valida", 502);
  }

  return email;
}

class GmailAccountStore {
  constructor(options = {}) {
    this.dataFile =
      options.dataFile ||
      path.join(__dirname, "..", "data", "gmail-accounts.json");
    this.encryptionSecret =
      options.encryptionSecret || process.env.GMAIL_TOKEN_ENCRYPTION_KEY || "";
  }

  ensureEncryptionConfigured() {
    if (Buffer.byteLength(this.encryptionSecret, "utf8") < 32) {
      throw httpError(
        "GMAIL_TOKEN_ENCRYPTION_KEY debe tener al menos 32 caracteres",
        503
      );
    }
  }

  getEncryptionKey() {
    this.ensureEncryptionConfigured();
    return crypto
      .createHash("sha256")
      .update(this.encryptionSecret, "utf8")
      .digest();
  }

  encryptToken(token) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.getEncryptionKey(), iv);
    const encrypted = Buffer.concat([
      cipher.update(String(token), "utf8"),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    return [
      "v1",
      iv.toString("base64url"),
      tag.toString("base64url"),
      encrypted.toString("base64url")
    ].join(".");
  }

  decryptToken(value) {
    const [version, ivValue, tagValue, encryptedValue] = String(value || "").split(
      "."
    );

    if (
      version !== "v1" ||
      !ivValue ||
      !tagValue ||
      !encryptedValue
    ) {
      throw httpError("El token OAuth guardado tiene un formato invalido", 500);
    }

    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.getEncryptionKey(),
        Buffer.from(ivValue, "base64url")
      );
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, "base64url")),
        decipher.final()
      ]).toString("utf8");
    } catch (error) {
      throw httpError(
        "No se pudo descifrar el token OAuth. Revisa GMAIL_TOKEN_ENCRYPTION_KEY",
        500
      );
    }
  }

  readRegistry() {
    if (!fs.existsSync(this.dataFile)) {
      return {
        version: 1,
        cuentas: []
      };
    }

    try {
      const registry = JSON.parse(fs.readFileSync(this.dataFile, "utf8"));

      if (registry.version !== 1 || !Array.isArray(registry.cuentas)) {
        throw new Error("estructura no reconocida");
      }

      return registry;
    } catch (error) {
      throw httpError(
        `No se pudo leer el registro de cuentas Gmail: ${error.message}`,
        500
      );
    }
  }

  writeRegistry(registry) {
    const directory = path.dirname(this.dataFile);
    const temporaryFile = `${this.dataFile}.${process.pid}.${crypto
      .randomBytes(6)
      .toString("hex")}.tmp`;

    fs.mkdirSync(directory, { recursive: true });

    try {
      fs.writeFileSync(temporaryFile, `${JSON.stringify(registry, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      fs.renameSync(temporaryFile, this.dataFile);
    } finally {
      if (fs.existsSync(temporaryFile)) {
        fs.rmSync(temporaryFile, { force: true });
      }
    }
  }

  toPublicAccount(account) {
    return {
      identificacion: account.identificacion,
      email: account.email,
      scopes: account.scopes || [],
      creadaEn: account.creadaEn,
      actualizadaEn: account.actualizadaEn
    };
  }

  listAccounts() {
    return this.readRegistry().cuentas
      .map((account) => this.toPublicAccount(account))
      .sort((left, right) =>
        left.identificacion.localeCompare(right.identificacion)
      );
  }

  findStoredAccount(identification) {
    const normalized = normalizeIdentification(identification);
    return (
      this.readRegistry().cuentas.find(
        (account) => account.identificacion === normalized
      ) || null
    );
  }

  getAuthorizedAccount(identification) {
    const account = this.findStoredAccount(identification);

    if (!account) {
      throw httpError(
        `La cuenta Gmail ${normalizeIdentification(identification)} no existe`,
        404
      );
    }

    return {
      ...this.toPublicAccount(account),
      refreshToken: this.decryptToken(account.refreshToken)
    };
  }

  removeAccount(identification) {
    const normalizedIdentification = normalizeIdentification(identification);
    const registry = this.readRegistry();
    const index = registry.cuentas.findIndex(
      (account) => account.identificacion === normalizedIdentification
    );

    if (index < 0) {
      throw httpError(
        `La cuenta Gmail ${normalizedIdentification} no existe`,
        404
      );
    }

    const account = registry.cuentas[index];
    const refreshToken = this.decryptToken(account.refreshToken);
    registry.cuentas.splice(index, 1);
    this.writeRegistry(registry);

    return {
      ...this.toPublicAccount(account),
      refreshToken
    };
  }

  saveAuthorizedAccount({ identification, email, refreshToken, scopes = [] }) {
    const normalizedIdentification = normalizeIdentification(identification);
    const normalizedEmail = normalizeEmail(email);
    const registry = this.readRegistry();
    const now = new Date().toISOString();
    const index = registry.cuentas.findIndex(
      (account) => account.identificacion === normalizedIdentification
    );
    const accountWithSameEmail = registry.cuentas.find(
      (account) =>
        account.email === normalizedEmail &&
        account.identificacion !== normalizedIdentification
    );

    if (accountWithSameEmail) {
      throw httpError(
        `${normalizedEmail} ya esta asociada a ${accountWithSameEmail.identificacion}`,
        409
      );
    }

    if (
      index >= 0 &&
      registry.cuentas[index].email !== normalizedEmail
    ) {
      throw httpError(
        `${normalizedIdentification} ya esta asociada a ${registry.cuentas[index].email}`,
        409
      );
    }

    if (!refreshToken && index < 0) {
      throw httpError(
        "Google no devolvio refresh_token. Vuelve a autorizar la cuenta",
        502
      );
    }

    const previous = index >= 0 ? registry.cuentas[index] : null;
    const account = {
      identificacion: normalizedIdentification,
      email: normalizedEmail,
      refreshToken: refreshToken
        ? this.encryptToken(refreshToken)
        : previous.refreshToken,
      scopes: Array.from(new Set(scopes)).sort(),
      creadaEn: previous?.creadaEn || now,
      actualizadaEn: now
    };

    if (index >= 0) {
      registry.cuentas[index] = account;
    } else {
      registry.cuentas.push(account);
    }

    this.writeRegistry(registry);
    return this.toPublicAccount(account);
  }
}

module.exports = {
  GmailAccountStore,
  normalizeIdentification
};
