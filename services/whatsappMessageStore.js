const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DEFAULT_TIME_ZONE = "America/Argentina/Buenos_Aires";

function toUnixSeconds(value) {
  const numericValue =
    typeof value?.toNumber === "function" ? value.toNumber() : Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return Math.floor(Date.now() / 1000);
  }

  return Math.floor(numericValue > 1_000_000_000_000
    ? numericValue / 1000
    : numericValue);
}

function unwrapMessageContent(message) {
  let content = message || null;
  const wrappers = [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage"
  ];

  for (let depth = 0; content && depth < 5; depth += 1) {
    const wrapper = wrappers.find((key) => content[key]?.message);
    if (!wrapper) {
      break;
    }
    content = content[wrapper].message;
  }

  return content;
}

function getMessageType(content) {
  if (!content || typeof content !== "object") {
    return "desconocido";
  }

  return (
    Object.keys(content).find(
      (key) =>
        key !== "messageContextInfo" &&
        key !== "senderKeyDistributionMessage"
    ) || "desconocido"
  );
}

function getMessageText(content) {
  if (!content || typeof content !== "object") {
    return null;
  }

  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.contactMessage?.displayName ||
    content.locationMessage?.name ||
    content.locationMessage?.address ||
    content.reactionMessage?.text ||
    null
  );
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item
    );
  } catch {
    return null;
  }
}

function isPhoneJid(value) {
  return /^\d+(?::\d+)?@s\.whatsapp\.net$/.test(String(value || ""));
}

function getPhoneJidFromMessageKey(key = {}) {
  if (isPhoneJid(key.remoteJidAlt)) {
    return key.remoteJidAlt;
  }

  if (!key.fromMe && isPhoneJid(key.senderPn)) {
    return key.senderPn;
  }

  return null;
}

function getZonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second
  };
}

function zonedDateTimeToUtc(parts, timeZone) {
  const desiredLocalTime = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0
  );
  let candidate = desiredLocalTime;

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const rendered = getZonedParts(new Date(candidate), timeZone);
    const renderedLocalTime = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second
    );
    candidate += desiredLocalTime - renderedLocalTime;
  }

  return candidate;
}

function getDayWindow(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const local = getZonedParts(now, timeZone);
  const nextDay = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const startMs = zonedDateTimeToUtc(
    { year: local.year, month: local.month, day: local.day },
    timeZone
  );
  const endMs = zonedDateTimeToUtc(
    {
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate()
    },
    timeZone
  );

  return {
    date: [
      String(local.year).padStart(4, "0"),
      String(local.month).padStart(2, "0"),
      String(local.day).padStart(2, "0")
    ].join("-"),
    startSeconds: Math.floor(startMs / 1000),
    endSeconds: Math.floor(endMs / 1000)
  };
}

function parseDate(value, fieldName) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));

  if (!match) {
    const error = new Error(`${fieldName} debe tener formato AAAA-MM-DD`);
    error.statusCode = 400;
    throw error;
  }

  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
  const validationDate = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day)
  );

  if (
    validationDate.getUTCFullYear() !== parts.year ||
    validationDate.getUTCMonth() + 1 !== parts.month ||
    validationDate.getUTCDate() !== parts.day
  ) {
    const error = new Error(`${fieldName} no es una fecha valida`);
    error.statusCode = 400;
    throw error;
  }

  return parts;
}

function formatDateParts(parts) {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0")
  ].join("-");
}

function getDateRangeWindow(from, to, timeZone = DEFAULT_TIME_ZONE) {
  const fromParts = parseDate(from, "desde");
  const toParts = parseDate(to, "hasta");
  const fromUtcDate = Date.UTC(
    fromParts.year,
    fromParts.month - 1,
    fromParts.day
  );
  const toUtcDate = Date.UTC(toParts.year, toParts.month - 1, toParts.day);

  if (fromUtcDate > toUtcDate) {
    const error = new Error("desde no puede ser posterior a hasta");
    error.statusCode = 400;
    throw error;
  }

  const nextDay = new Date(toUtcDate);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const startMs = zonedDateTimeToUtc(fromParts, timeZone);
  const endMs = zonedDateTimeToUtc(
    {
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate()
    },
    timeZone
  );

  return {
    from: formatDateParts(fromParts),
    to: formatDateParts(toParts),
    startSeconds: Math.floor(startMs / 1000),
    endSeconds: Math.floor(endMs / 1000)
  };
}

function getChatNumber(jid) {
  const localPart = String(jid || "").split("@")[0].split(":")[0];
  return localPart.replace(/\D/g, "") || localPart || "Desconocido";
}

function getMessagePreview(message) {
  if (message.texto) {
    return message.texto;
  }

  const labels = {
    imageMessage: "Imagen",
    videoMessage: "Video",
    audioMessage: "Audio",
    documentMessage: "Documento",
    stickerMessage: "Sticker",
    contactMessage: "Contacto",
    locationMessage: "Ubicacion",
    reactionMessage: "Reaccion"
  };

  return `[${labels[message.tipo] || "Mensaje"}]`;
}

function buildMessageReport(instanceId, messages, range, timeZone) {
  const conversationsByChat = new Map();
  const pendingInboundByChat = new Map();
  const responseTimes = [];
  let sent = 0;
  let received = 0;

  for (const message of messages) {
    let conversation = conversationsByChat.get(message.chat);

    if (!conversation) {
      conversation = {
        chat: message.chat,
        numero: getChatNumber(message.chat),
        esGrupo: message.chat.endsWith("@g.us"),
        enviados: 0,
        recibidos: 0,
        total: 0,
        ultimoMensaje: null,
        ultimoMensajeEn: null,
        mensajes: []
      };
      conversationsByChat.set(message.chat, conversation);
    }

    conversation.mensajes.push(message);
    conversation.total += 1;
    conversation.ultimoMensaje = getMessagePreview(message);
    conversation.ultimoMensajeEn = message.fecha;

    if (message.direccion === "enviado") {
      sent += 1;
      conversation.enviados += 1;
      const pendingInbound = pendingInboundByChat.get(message.chat);

      if (pendingInbound !== undefined && message.timestamp >= pendingInbound) {
        responseTimes.push(message.timestamp - pendingInbound);
        pendingInboundByChat.delete(message.chat);
      }
    } else {
      received += 1;
      conversation.recibidos += 1;
      pendingInboundByChat.set(message.chat, message.timestamp);
    }
  }

  const conversations = [...conversationsByChat.values()].sort((a, b) =>
    String(b.ultimoMensajeEn).localeCompare(String(a.ultimoMensajeEn))
  );
  const averageResponseSeconds = responseTimes.length
    ? Math.round(
        responseTimes.reduce((total, seconds) => total + seconds, 0) /
          responseTimes.length
      )
    : null;

  return {
    instancia: instanceId,
    desde: range.from,
    hasta: range.to,
    zonaHoraria: timeZone,
    cantidad: messages.length,
    estadisticas: {
      mensajesRecibidos: received,
      mensajesEnviados: sent,
      tiempoPromedioRespuestaSegundos: averageResponseSeconds,
      respuestasMedidas: responseTimes.length,
      conversaciones: conversations.length
    },
    conversaciones: conversations,
    mensajes: messages
  };
}

class WhatsAppMessageStore {
  constructor(options = {}) {
    this.databaseFile =
      options.databaseFile ||
      path.join(__dirname, "..", "data", "whatsapp-messages.sqlite");
    fs.mkdirSync(path.dirname(this.databaseFile), { recursive: true });
    this.database = new Database(this.databaseFile);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        instance_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        remote_jid TEXT NOT NULL,
        participant_jid TEXT,
        direction TEXT NOT NULL CHECK(direction IN ('enviado', 'recibido')),
        message_type TEXT NOT NULL,
        text TEXT,
        message_timestamp INTEGER NOT NULL,
        raw_message TEXT,
        captured_at TEXT NOT NULL,
        PRIMARY KEY (instance_id, remote_jid, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_instance_timestamp
      ON whatsapp_messages(instance_id, message_timestamp);

      CREATE TABLE IF NOT EXISTS whatsapp_conversation_labels (
        instance_id TEXT NOT NULL,
        remote_jid TEXT NOT NULL,
        number TEXT NOT NULL,
        category TEXT NOT NULL,
        state TEXT NOT NULL,
        requires_action INTEGER NOT NULL CHECK(requires_action IN (0, 1)),
        motive TEXT NOT NULL,
        analyzed_at TEXT NOT NULL,
        PRIMARY KEY (instance_id, remote_jid)
      );

      CREATE TABLE IF NOT EXISTS whatsapp_inbox_settings (
        instance_id TEXT PRIMARY KEY,
        analyst_prompt TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.lidToPhoneJid = new Map();
    this.removeLegacyDuplicates();
    this.migrateLidChatsToPhoneJids();
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_instance_message
      ON whatsapp_messages(instance_id, message_id);
    `);
    this.upsertLabelStatement = this.database.prepare(`
      INSERT INTO whatsapp_conversation_labels (
        instance_id, remote_jid, number, category, state,
        requires_action, motive, analyzed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, remote_jid) DO UPDATE SET
        number = excluded.number,
        category = excluded.category,
        state = excluded.state,
        requires_action = excluded.requires_action,
        motive = excluded.motive,
        analyzed_at = excluded.analyzed_at
    `);
    this.upsertLabelsTransaction = this.database.transaction((instanceId, labels) => {
      for (const label of labels) {
        this.upsertLabelStatement.run(
          instanceId,
          label.chat,
          label.numero,
          label.categoria,
          label.estado,
          label.requiereAccion ? 1 : 0,
          label.motivo,
          label.analizadoEn
        );
      }
    });
    this.upsertStatement = this.database.prepare(`
      INSERT INTO whatsapp_messages (
        instance_id,
        message_id,
        remote_jid,
        participant_jid,
        direction,
        message_type,
        text,
        message_timestamp,
        raw_message,
        captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, message_id) DO UPDATE SET
        remote_jid = excluded.remote_jid,
        participant_jid = COALESCE(excluded.participant_jid, participant_jid),
        direction = excluded.direction,
        message_type = excluded.message_type,
        text = COALESCE(excluded.text, text),
        message_timestamp = excluded.message_timestamp,
        raw_message = COALESCE(excluded.raw_message, raw_message)
    `);
    this.selectRangeStatement = this.database.prepare(`
      SELECT
        message_id,
        remote_jid,
        participant_jid,
        direction,
        message_type,
        text,
        message_timestamp,
        captured_at
      FROM whatsapp_messages
      WHERE instance_id = ?
        AND message_timestamp >= ?
        AND message_timestamp < ?
        AND remote_jid <> 'status@broadcast'
        AND remote_jid NOT LIKE '%@newsletter'
      ORDER BY message_timestamp ASC, message_id ASC
    `);
  }

  getLidMappingKey(instanceId, lidJid) {
    return `${instanceId}\u0000${lidJid}`;
  }

  removeLegacyDuplicates() {
    const duplicateRows = this.database
      .prepare(`
        SELECT rowid, instance_id, message_id, remote_jid
        FROM whatsapp_messages
        WHERE (instance_id, message_id) IN (
          SELECT instance_id, message_id
          FROM whatsapp_messages
          GROUP BY instance_id, message_id
          HAVING COUNT(*) > 1
        )
        ORDER BY instance_id, message_id, rowid
      `)
      .all();
    const rowsByMessage = new Map();

    for (const row of duplicateRows) {
      const key = `${row.instance_id}\u0000${row.message_id}`;
      const group = rowsByMessage.get(key) || [];
      group.push(row);
      rowsByMessage.set(key, group);
    }

    const remove = this.database.prepare(
      "DELETE FROM whatsapp_messages WHERE rowid = ?"
    );
    const cleanup = this.database.transaction(() => {
      for (const rows of rowsByMessage.values()) {
        const preferred =
          rows.find((row) => !row.remote_jid.endsWith("@lid")) || rows[0];
        for (const row of rows) {
          if (row.rowid !== preferred.rowid) {
            remove.run(row.rowid);
          }
        }
      }
    });

    cleanup();
  }

  rememberPhoneJid(instanceId, lidJid, phoneJid) {
    if (!String(lidJid || "").endsWith("@lid") || !isPhoneJid(phoneJid)) {
      return;
    }

    this.lidToPhoneJid.set(
      this.getLidMappingKey(instanceId, lidJid),
      phoneJid
    );
    this.database
      .prepare(`
        UPDATE whatsapp_messages
        SET remote_jid = ?
        WHERE instance_id = ? AND remote_jid = ?
      `)
      .run(phoneJid, instanceId, lidJid);
  }

  resolveRemoteJid(instanceId, message, overrides = {}) {
    const rawRemoteJid = overrides.remoteJid || message?.key?.remoteJid;

    if (!String(rawRemoteJid || "").endsWith("@lid")) {
      return rawRemoteJid;
    }

    const phoneJid = getPhoneJidFromMessageKey(message?.key);
    if (phoneJid) {
      this.rememberPhoneJid(instanceId, rawRemoteJid, phoneJid);
      return phoneJid;
    }

    return (
      this.lidToPhoneJid.get(
        this.getLidMappingKey(instanceId, rawRemoteJid)
      ) || rawRemoteJid
    );
  }

  migrateLidChatsToPhoneJids() {
    const rows = this.database
      .prepare(`
        SELECT rowid, instance_id, remote_jid, raw_message
        FROM whatsapp_messages
        WHERE remote_jid LIKE '%@lid'
      `)
      .all();

    for (const row of rows) {
      try {
        const message = JSON.parse(row.raw_message || "null");
        const phoneJid = getPhoneJidFromMessageKey(message?.key);
        if (phoneJid) {
          this.rememberPhoneJid(row.instance_id, row.remote_jid, phoneJid);
        }
      } catch {
        // A malformed historical payload remains available under its LID.
      }
    }

    const update = this.database.prepare(`
      UPDATE whatsapp_messages
      SET remote_jid = ?
      WHERE rowid = ?
    `);
    const migrate = this.database.transaction(() => {
      for (const row of rows) {
        const phoneJid = this.lidToPhoneJid.get(
          this.getLidMappingKey(row.instance_id, row.remote_jid)
        );
        if (phoneJid) {
          update.run(phoneJid, row.rowid);
        }
      }
    });

    migrate();
  }

  saveMessage(instanceId, message, overrides = {}) {
    const messageId = message?.key?.id;
    const remoteJid = this.resolveRemoteJid(instanceId, message, overrides);

    if (!instanceId || !messageId || !remoteJid || !message?.message) {
      return false;
    }

    if (
      remoteJid === "status@broadcast" ||
      remoteJid.endsWith("@newsletter")
    ) {
      return false;
    }

    const content = unwrapMessageContent(message.message);
    const direction =
      overrides.direction || (message.key.fromMe ? "enviado" : "recibido");
    const text =
      overrides.text === undefined ? getMessageText(content) : overrides.text;

    this.upsertStatement.run(
      instanceId,
      messageId,
      remoteJid,
      message.key.participantPn || message.key.participant || null,
      direction,
      getMessageType(content),
      text || null,
      toUnixSeconds(message.messageTimestamp),
      safeJsonStringify(message),
      new Date().toISOString()
    );

    return true;
  }

  getMessagesForRange(instanceId, startSeconds, endSeconds) {
    return this.selectRangeStatement
      .all(instanceId, startSeconds, endSeconds)
      .map((row) => ({
        id: row.message_id,
        chat: row.remote_jid,
        participante: row.participant_jid,
        direccion: row.direction,
        tipo: row.message_type,
        texto: row.text,
        timestamp: row.message_timestamp,
        fecha: new Date(row.message_timestamp * 1000).toISOString(),
        capturadoEn: row.captured_at
      }));
  }

  getMessagesToday(
    instanceId,
    { now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}
  ) {
    const window = getDayWindow(now, timeZone);
    const messages = this.getMessagesForRange(
      instanceId,
      window.startSeconds,
      window.endSeconds
    );

    return {
      instancia: instanceId,
      fecha: window.date,
      zonaHoraria: timeZone,
      cantidad: messages.length,
      mensajes: messages
    };
  }

  getMessages(
    instanceId,
    { from, to, now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}
  ) {
    const today = getDayWindow(now, timeZone).date;
    const range = getDateRangeWindow(from || today, to || from || today, timeZone);
    const messages = this.getMessagesForRange(
      instanceId,
      range.startSeconds,
      range.endSeconds
    );

    const report = buildMessageReport(instanceId, messages, range, timeZone);
    const labels = new Map(
      this.database
        .prepare(`
          SELECT remote_jid, category, state, requires_action, motive, analyzed_at
          FROM whatsapp_conversation_labels
          WHERE instance_id = ?
        `)
        .all(instanceId)
        .map((row) => [row.remote_jid, {
          categoria: row.category,
          estado: row.state,
          requiereAccion: Boolean(row.requires_action),
          motivo: row.motive,
          analizadoEn: row.analyzed_at
        }])
    );
    report.conversaciones.forEach((conversation) => {
      conversation.etiqueta = labels.get(conversation.chat) || null;
    });
    return report;
  }

  saveConversationLabels(instanceId, labels, analyzedAt = new Date().toISOString()) {
    const normalized = (labels || []).map((label) => ({
      ...label,
      analizadoEn: analyzedAt
    }));
    this.upsertLabelsTransaction(instanceId, normalized);
    return normalized.length;
  }

  getAnalystPrompt(instanceId) {
    return this.database
      .prepare("SELECT analyst_prompt FROM whatsapp_inbox_settings WHERE instance_id = ?")
      .get(instanceId)?.analyst_prompt || null;
  }

  saveAnalystPrompt(instanceId, prompt) {
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO whatsapp_inbox_settings (instance_id, analyst_prompt, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET
        analyst_prompt = excluded.analyst_prompt,
        updated_at = excluded.updated_at
    `).run(instanceId, prompt, updatedAt);
    return updatedAt;
  }

  close() {
    this.database.close();
  }
}

module.exports = {
  DEFAULT_TIME_ZONE,
  WhatsAppMessageStore,
  buildMessageReport,
  getDateRangeWindow,
  getDayWindow,
  getMessageText,
  getMessageType,
  getPhoneJidFromMessageKey,
  isPhoneJid,
  toUnixSeconds,
  unwrapMessageContent
};
