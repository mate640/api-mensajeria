const crypto = require("crypto");

const {
  GmailAccountStore,
  normalizeIdentification
} = require("./gmailAccountStore");

const OAUTH_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send"
];

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireText(value, field, maximumLength = 1000) {
  const text = String(value || "").trim();

  if (!text) {
    throw httpError(`${field} es obligatorio`, 400);
  }

  if (text.length > maximumLength) {
    throw httpError(`${field} supera el largo permitido`, 400);
  }

  return text;
}

function normalizeRecipients(value, field) {
  const values = Array.isArray(value) ? value : [value];
  const recipients = values.map((item) => String(item || "").trim()).filter(Boolean);

  if (field === "para" && recipients.length === 0) {
    throw httpError("para es obligatorio", 400);
  }

  for (const recipient of recipients) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      throw httpError(`${field} contiene una direccion de email invalida`, 400);
    }
  }

  return recipients;
}

function normalizeRfcMessageId(value, field) {
  const messageId = String(value || "").trim();

  if (!/^<[^<>\s]+>$/.test(messageId)) {
    throw httpError(`${field} debe ser un Message-ID RFC valido`, 400);
  }

  return messageId;
}

function encodeHeader(value) {
  const text = String(value);

  if (/^[\x20-\x7e]*$/.test(text)) {
    return text;
  }

  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function encodeBody(value) {
  return Buffer.from(String(value), "utf8")
    .toString("base64")
    .match(/.{1,76}/g)
    .join("\r\n");
}

function buildMimeMessage({
  from,
  to,
  cc,
  bcc,
  subject,
  text,
  html,
  messageId,
  inReplyTo,
  references
}) {
  const headers = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    ...(cc.length > 0 ? [`Cc: ${cc.join(", ")}`] : []),
    ...(bcc.length > 0 ? [`Bcc: ${bcc.join(", ")}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0"
  ];

  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${references.join(" ")}`);
  }

  if (text && html) {
    const boundary = `mensajeria-${crypto.randomBytes(16).toString("hex")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

    return [
      ...headers,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      encodeBody(text),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      encodeBody(html),
      `--${boundary}--`,
      ""
    ].join("\r\n");
  }

  headers.push(
    `Content-Type: ${html ? "text/html" : "text/plain"}; charset="UTF-8"`
  );
  headers.push("Content-Transfer-Encoding: base64");

  return [...headers, "", encodeBody(html || text), ""].join("\r\n");
}

class GmailService {
  constructor(options = {}) {
    this.clientId = options.clientId || process.env.GOOGLE_CLIENT_ID || "";
    this.clientSecret =
      options.clientSecret || process.env.GOOGLE_CLIENT_SECRET || "";
    this.redirectUri =
      options.redirectUri || process.env.GOOGLE_REDIRECT_URI || "";
    this.stateSecret =
      options.stateSecret || process.env.GMAIL_OAUTH_STATE_SECRET || "";
    this.store = options.store || new GmailAccountStore();
    this.fetch = options.fetchImpl || global.fetch;
    this.accessTokens = new Map();
  }

  getStatus() {
    const oauthConfigured = Boolean(
      this.clientId &&
        this.clientSecret &&
        this.redirectUri &&
        Buffer.byteLength(this.stateSecret, "utf8") >= 32
    );
    const encryptionConfigured =
      Buffer.byteLength(this.store.encryptionSecret, "utf8") >= 32;
    const fullyConfigured = oauthConfigured && encryptionConfigured;
    let accounts = [];
    let storageError = null;

    try {
      accounts = this.store.listAccounts();
    } catch (error) {
      storageError = error.message;
    }

    return {
      configurado: fullyConfigured,
      estado: storageError
        ? "error_almacenamiento"
        : fullyConfigured
          ? "configurado"
          : "no_configurado",
      cuentas: accounts.length,
      ...(storageError ? { detalle: storageError } : {})
    };
  }

  ensureOauthConfigured() {
    const missing = [];

    if (!this.clientId) missing.push("GOOGLE_CLIENT_ID");
    if (!this.clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
    if (!this.redirectUri) missing.push("GOOGLE_REDIRECT_URI");
    if (Buffer.byteLength(this.stateSecret, "utf8") < 32) {
      missing.push("GMAIL_OAUTH_STATE_SECRET (minimo 32 caracteres)");
    }

    if (missing.length > 0) {
      throw httpError(`Falta configurar: ${missing.join(", ")}`, 503);
    }

    this.store.ensureEncryptionConfigured();
  }

  signState(identification, returnTo = "") {
    this.ensureOauthConfigured();
    const payload = Buffer.from(
      JSON.stringify({
        identificacion: normalizeIdentification(identification),
        nonce: crypto.randomBytes(16).toString("base64url"),
        exp: Date.now() + 10 * 60 * 1000,
        retorno: returnTo === "/gmail/panel" ? returnTo : ""
      })
    ).toString("base64url");
    const signature = crypto
      .createHmac("sha256", this.stateSecret)
      .update(payload)
      .digest("base64url");

    return `${payload}.${signature}`;
  }

  verifyState(state) {
    const [payload, receivedSignature] = String(state || "").split(".");

    if (!payload || !receivedSignature) {
      throw httpError("El estado OAuth es invalido", 400);
    }

    const expectedSignature = crypto
      .createHmac("sha256", this.stateSecret)
      .update(payload)
      .digest();
    let received;

    try {
      received = Buffer.from(receivedSignature, "base64url");
    } catch (error) {
      throw httpError("El estado OAuth es invalido", 400);
    }

    if (
      expectedSignature.length !== received.length ||
      !crypto.timingSafeEqual(expectedSignature, received)
    ) {
      throw httpError("La firma del estado OAuth es invalida", 400);
    }

    let data;

    try {
      data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch (error) {
      throw httpError("El estado OAuth no se pudo interpretar", 400);
    }

    if (!data.exp || data.exp < Date.now()) {
      throw httpError("El estado OAuth vencio. Inicia nuevamente la vinculacion", 400);
    }

    return {
      identificacion: normalizeIdentification(data.identificacion),
      retorno: data.retorno === "/gmail/panel" ? data.retorno : ""
    };
  }

  buildAuthorizationUrl(identification, loginHint, returnTo = "") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("state", this.signState(identification, returnTo));

    if (loginHint) {
      url.searchParams.set("login_hint", String(loginHint).trim());
    }

    return url.toString();
  }

  async requestJson(url, options, providerName) {
    let response;

    try {
      response = await this.fetch(url, options);
    } catch (error) {
      throw httpError(`No se pudo conectar con ${providerName}: ${error.message}`, 502);
    }

    const text = await response.text();
    let data = {};

    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        throw httpError(`${providerName} devolvio una respuesta invalida`, 502);
      }
    }

    if (!response.ok) {
      const detail =
        data.error_description ||
        data.error?.message ||
        data.error ||
        `HTTP ${response.status}`;
      throw httpError(`${providerName}: ${detail}`, 502);
    }

    return data;
  }

  async exchangeAuthorizationCode(code) {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: "authorization_code"
    });

    return this.requestJson(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      },
      "Google OAuth"
    );
  }

  async getGoogleIdentity(accessToken) {
    return this.requestJson(
      "https://openidconnect.googleapis.com/v1/userinfo",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      },
      "Google Identity"
    );
  }

  async completeAuthorization({ code, state }) {
    this.ensureOauthConfigured();
    const { identificacion, retorno } = this.verifyState(state);
    const authorizationCode = requireText(code, "code", 4096);
    const tokens = await this.exchangeAuthorizationCode(authorizationCode);

    if (!tokens.access_token) {
      throw httpError("Google no devolvio access_token", 502);
    }

    const identity = await this.getGoogleIdentity(tokens.access_token);

    if (!identity.email || identity.email_verified === false) {
      throw httpError("Google no devolvio un email verificado", 502);
    }

    const account = this.store.saveAuthorizedAccount({
      identification: identificacion,
      email: identity.email,
      refreshToken: tokens.refresh_token,
      scopes: String(tokens.scope || "")
        .split(/\s+/)
        .filter(Boolean)
    });

    this.accessTokens.set(identificacion, {
      value: tokens.access_token,
      expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000
    });

    return {
      account,
      returnTo: retorno
    };
  }

  listAccounts() {
    return this.store.listAccounts();
  }

  async removeAccount(identification) {
    this.store.ensureEncryptionConfigured();
    const normalizedIdentification = normalizeIdentification(identification);
    const account = this.store.removeAccount(normalizedIdentification);
    this.accessTokens.delete(normalizedIdentification);
    let revocationWarning = "";

    try {
      await this.requestJson(
        "https://oauth2.googleapis.com/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: account.refreshToken })
        },
        "Google OAuth"
      );
    } catch (error) {
      revocationWarning =
        "La cuenta fue eliminada localmente, pero Google no confirmo la revocacion";
    }

    return {
      identificacion: account.identificacion,
      email: account.email,
      eliminada: true,
      revocadaEnGoogle: !revocationWarning,
      ...(revocationWarning ? { advertencia: revocationWarning } : {})
    };
  }

  async getAccessToken(account) {
    const cached = this.accessTokens.get(account.identificacion);

    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.value;
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: account.refreshToken,
      grant_type: "refresh_token"
    });
    const tokens = await this.requestJson(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      },
      "Google OAuth"
    );

    if (!tokens.access_token) {
      throw httpError("Google no devolvio access_token", 502);
    }

    this.accessTokens.set(account.identificacion, {
      value: tokens.access_token,
      expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000
    });

    return tokens.access_token;
  }

  async buildRawMessage({
    account,
    to,
    cc,
    bcc,
    subject,
    text,
    html,
    inReplyTo,
    references
  }) {
    const domain = account.email.split("@")[1].replace(/[^a-z0-9.-]/gi, "");
    const messageId = `<${crypto.randomUUID()}@${domain}>`;
    const raw = buildMimeMessage({
      from: account.email,
      to,
      cc,
      bcc,
      subject,
      text,
      html,
      messageId,
      inReplyTo,
      references
    });

    return {
      messageId,
      raw: Buffer.from(raw, "utf8").toString("base64url")
    };
  }

  async sendEmail(payload) {
    this.ensureOauthConfigured();
    const identification = normalizeIdentification(payload.identificacion);
    const account = this.store.getAuthorizedAccount(identification);
    const to = normalizeRecipients(payload.para, "para");
    const cc = payload.cc ? normalizeRecipients(payload.cc, "cc") : [];
    const bcc = payload.bcc ? normalizeRecipients(payload.bcc, "bcc") : [];
    const subject = requireText(payload.asunto, "asunto", 250);
    const text = String(payload.texto || "");
    const html = String(payload.html || "");
    const threadId = String(payload.threadId || "").trim();
    const inReplyTo = payload.inReplyTo
      ? normalizeRfcMessageId(payload.inReplyTo, "inReplyTo")
      : "";
    const referencesInput = Array.isArray(payload.references)
      ? payload.references
      : payload.references
        ? [payload.references]
        : [];
    const references = referencesInput.map((value) =>
      normalizeRfcMessageId(value, "references")
    );

    if (!text.trim() && !html.trim()) {
      throw httpError("texto o html es obligatorio", 400);
    }

    if (threadId && !inReplyTo) {
      throw httpError(
        "inReplyTo es obligatorio al responder una conversacion",
        400
      );
    }

    if (inReplyTo && !references.includes(inReplyTo)) {
      references.push(inReplyTo);
    }

    const { messageId, raw } = await this.buildRawMessage({
      account,
      to,
      cc,
      bcc,
      subject,
      text,
      html,
      inReplyTo: threadId ? inReplyTo : "",
      references
    });
    const accessToken = await this.getAccessToken(account);
    const requestBody = { raw };

    if (threadId) {
      requestBody.threadId = threadId;
    }

    const sent = await this.requestJson(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      },
      "Gmail API"
    );

    return {
      ok: true,
      canal: "gmail",
      identificacion: identification,
      cuenta: account.email,
      gmailMessageId: sent.id,
      gmailThreadId: sent.threadId,
      rfcMessageId: messageId
    };
  }
}

module.exports = {
  GmailService,
  OAUTH_SCOPES,
  buildMimeMessage,
  normalizeRecipients,
  gmailService: new GmailService()
};
