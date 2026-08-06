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

function isLidJid(value) {
  return /^\d+@lid$/.test(String(value || ""));
}

function normalizeContactName(value) {
  const name = String(value || "").trim();
  return name || null;
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

      CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_instance_remote
      ON whatsapp_messages(instance_id, remote_jid);

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

      CREATE TABLE IF NOT EXISTS whatsapp_contacts (
        instance_id TEXT NOT NULL,
        contact_jid TEXT NOT NULL,
        phone_jid TEXT,
        lid_jid TEXT,
        saved_name TEXT,
        notify_name TEXT,
        verified_name TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (instance_id, contact_jid)
      );

      CREATE INDEX IF NOT EXISTS idx_whatsapp_contacts_instance_phone
      ON whatsapp_contacts(instance_id, phone_jid);

      CREATE INDEX IF NOT EXISTS idx_whatsapp_contacts_instance_lid
      ON whatsapp_contacts(instance_id, lid_jid);

      CREATE TABLE IF NOT EXISTS whatsapp_groups (
        instance_id TEXT NOT NULL,
        group_jid TEXT NOT NULL,
        subject TEXT NOT NULL,
        description TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (instance_id, group_jid)
      );

      CREATE TABLE IF NOT EXISTS whatsapp_capture_settings (
        instance_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('todo', 'seleccionados', 'nada')),
        retention_days INTEGER,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS whatsapp_capture_targets (
        instance_id TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK(target_type IN ('contacto', 'grupo')),
        PRIMARY KEY (instance_id, chat_jid)
      );
    `);
    const captureSettingColumns = this.database
      .pragma("table_info(whatsapp_capture_settings)")
      .map((column) => column.name);
    if (!captureSettingColumns.includes("retention_days")) {
      this.database.exec(`
        ALTER TABLE whatsapp_capture_settings
        ADD COLUMN retention_days INTEGER
      `);
    }
    this.lidToPhoneJid = new Map();
    this.upsertContactStatement = this.database.prepare(`
      INSERT INTO whatsapp_contacts (
        instance_id, contact_jid, phone_jid, lid_jid, saved_name,
        notify_name, verified_name, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, contact_jid) DO UPDATE SET
        phone_jid = COALESCE(excluded.phone_jid, phone_jid),
        lid_jid = COALESCE(excluded.lid_jid, lid_jid),
        saved_name = COALESCE(excluded.saved_name, saved_name),
        notify_name = COALESCE(excluded.notify_name, notify_name),
        verified_name = COALESCE(excluded.verified_name, verified_name),
        updated_at = excluded.updated_at
    `);
    this.selectContactAliasesStatement = this.database.prepare(`
      SELECT *
      FROM whatsapp_contacts
      WHERE instance_id = ?
        AND (
          contact_jid IN (?, ?)
          OR phone_jid IN (?, ?)
          OR lid_jid IN (?, ?)
        )
    `);
    this.selectContactStatement = this.database.prepare(`
      SELECT *
      FROM whatsapp_contacts
      WHERE instance_id = ?
        AND (contact_jid = ? OR phone_jid = ? OR lid_jid = ?)
      ORDER BY
        CASE WHEN saved_name IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN verified_name IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN notify_name IS NOT NULL THEN 0 ELSE 1 END
      LIMIT 1
    `);
    this.saveContactsTransaction = this.database.transaction(
      (instanceId, contacts) => {
        for (const contact of contacts) {
          this.saveContact(instanceId, contact);
        }
      }
    );
    this.upsertGroupStatement = this.database.prepare(`
      INSERT INTO whatsapp_groups (
        instance_id, group_jid, subject, description, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, group_jid) DO UPDATE SET
        subject = excluded.subject,
        description = excluded.description,
        updated_at = excluded.updated_at
    `);
    this.selectGroupStatement = this.database.prepare(`
      SELECT subject, description
      FROM whatsapp_groups
      WHERE instance_id = ? AND group_jid = ?
    `);
    this.saveGroupsTransaction = this.database.transaction(
      (instanceId, groups) => {
        for (const group of groups) {
          this.saveGroup(instanceId, group);
        }
      }
    );
    this.selectCaptureModeStatement = this.database.prepare(`
      SELECT mode, updated_at
      FROM whatsapp_capture_settings
      WHERE instance_id = ?
    `);
    this.isCaptureTargetSelectedStatement = this.database.prepare(`
      SELECT 1
      FROM whatsapp_capture_targets
      WHERE instance_id = ? AND chat_jid = ?
    `);
    this.replaceCaptureSettingsTransaction = this.database.transaction(
      (instanceId, mode, targets, updatedAt) => {
        this.database.prepare(`
          INSERT INTO whatsapp_capture_settings (
            instance_id, mode, retention_days, updated_at
          )
          VALUES (?, ?, ?, ?)
          ON CONFLICT(instance_id) DO UPDATE SET
            mode = excluded.mode,
            retention_days = excluded.retention_days,
            updated_at = excluded.updated_at
        `).run(instanceId, mode, targets.retentionDays, updatedAt);
        this.database.prepare(`
          DELETE FROM whatsapp_capture_targets WHERE instance_id = ?
        `).run(instanceId);
        const insert = this.database.prepare(`
          INSERT INTO whatsapp_capture_targets (
            instance_id, chat_jid, target_type
          ) VALUES (?, ?, ?)
        `);
        for (const target of targets.items) {
          insert.run(instanceId, target.id, target.type);
        }
      }
    );
    this.clearInboxTransaction = this.database.transaction((instanceId) => {
      const messages = this.database.prepare(`
        DELETE FROM whatsapp_messages WHERE instance_id = ?
      `).run(instanceId).changes;
      const labels = this.database.prepare(`
        DELETE FROM whatsapp_conversation_labels WHERE instance_id = ?
      `).run(instanceId).changes;
      return { messages, labels };
    });
    this.loadContactMappings();
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
        CASE
          WHEN json_valid(raw_message)
          THEN json_extract(raw_message, '$.pushName')
          ELSE NULL
        END AS push_name,
        CASE
          WHEN json_valid(raw_message)
          THEN json_extract(raw_message, '$.verifiedBizName')
          ELSE NULL
        END AS verified_biz_name,
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

  loadContactMappings() {
    const mappings = this.database
      .prepare(`
        SELECT DISTINCT instance_id, lid_jid, phone_jid
        FROM whatsapp_contacts
        WHERE lid_jid IS NOT NULL AND phone_jid IS NOT NULL
      `)
      .all();

    for (const mapping of mappings) {
      if (isLidJid(mapping.lid_jid) && isPhoneJid(mapping.phone_jid)) {
        this.lidToPhoneJid.set(
          this.getLidMappingKey(mapping.instance_id, mapping.lid_jid),
          mapping.phone_jid
        );
      }
    }
  }

  saveContacts(instanceId, contacts) {
    const validContacts = (contacts || []).filter(
      (contact) => contact && typeof contact === "object"
    );

    if (!instanceId || !validContacts.length) {
      return 0;
    }

    this.saveContactsTransaction(instanceId, validContacts);
    return validContacts.length;
  }

  saveContact(instanceId, contact = {}) {
    if (!instanceId) {
      return false;
    }

    const id = String(contact.id || "").trim() || null;
    const phoneJid = [contact.jid, id].find(isPhoneJid) || null;
    const lidJid = [contact.lid, id].find(isLidJid) || null;

    if (!id && !phoneJid && !lidJid) {
      return false;
    }

    const aliases = [phoneJid, lidJid].filter(Boolean);
    const lookupA = aliases[0] || id;
    const lookupB = aliases[1] || lookupA;
    const existing = this.selectContactAliasesStatement.all(
      instanceId,
      lookupA,
      lookupB,
      lookupA,
      lookupB,
      lookupA,
      lookupB
    );
    const resolvedPhoneJid =
      phoneJid || existing.find((row) => isPhoneJid(row.phone_jid))?.phone_jid || null;
    const resolvedLidJid =
      lidJid || existing.find((row) => isLidJid(row.lid_jid))?.lid_jid || null;
    const savedName =
      normalizeContactName(contact.name) ||
      existing.find((row) => row.saved_name)?.saved_name ||
      null;
    const notifyName =
      normalizeContactName(contact.notify) ||
      existing.find((row) => row.notify_name)?.notify_name ||
      null;
    const verifiedName =
      normalizeContactName(contact.verifiedName) ||
      existing.find((row) => row.verified_name)?.verified_name ||
      null;
    const updatedAt = new Date().toISOString();
    const contactJids = new Set(
      [id, resolvedPhoneJid, resolvedLidJid].filter(Boolean)
    );

    for (const contactJid of contactJids) {
      this.upsertContactStatement.run(
        instanceId,
        contactJid,
        resolvedPhoneJid,
        resolvedLidJid,
        savedName,
        notifyName,
        verifiedName,
        updatedAt
      );
    }

    if (resolvedPhoneJid && resolvedLidJid) {
      this.rememberPhoneJid(instanceId, resolvedLidJid, resolvedPhoneJid);
    }

    return true;
  }

  savePhoneNumberShare(instanceId, mapping = {}) {
    if (!isLidJid(mapping.lid) || !isPhoneJid(mapping.jid)) {
      return false;
    }

    return this.saveContact(instanceId, {
      id: mapping.jid,
      jid: mapping.jid,
      lid: mapping.lid
    });
  }

  getContactStats(instanceId) {
    return this.database.prepare(`
      WITH identities AS (
        SELECT
          COALESCE(phone_jid, lid_jid, contact_jid) AS identity_jid,
          MAX(CASE WHEN saved_name IS NOT NULL THEN 1 ELSE 0 END) AS has_saved_name,
          MAX(
            CASE
              WHEN saved_name IS NOT NULL
                OR notify_name IS NOT NULL
                OR verified_name IS NOT NULL
              THEN 1
              ELSE 0
            END
          ) AS has_name,
          MAX(CASE WHEN phone_jid IS NOT NULL THEN 1 ELSE 0 END) AS has_phone
        FROM whatsapp_contacts
        WHERE instance_id = ?
        GROUP BY COALESCE(phone_jid, lid_jid, contact_jid)
      )
      SELECT
        COUNT(*) AS contactos,
        COALESCE(SUM(has_saved_name), 0) AS nombresAgendados,
        COALESCE(SUM(has_name), 0) AS contactosConNombre,
        COALESCE(SUM(has_phone), 0) AS contactosConTelefono
      FROM identities
    `).get(instanceId);
  }

  saveGroups(instanceId, groups) {
    const validGroups = (groups || []).filter(
      (group) => group && typeof group === "object"
    );

    if (!instanceId || !validGroups.length) {
      return 0;
    }

    this.saveGroupsTransaction(instanceId, validGroups);
    return validGroups.length;
  }

  saveGroup(instanceId, group = {}) {
    const groupJid = String(group.id || group.groupId || "").trim();
    const subject = String(group.subject || group.nombre || "").trim();

    if (!instanceId || !groupJid.endsWith("@g.us") || !subject) {
      return false;
    }

    this.upsertGroupStatement.run(
      instanceId,
      groupJid,
      subject,
      String(group.desc || group.descripcion || "").trim() || null,
      new Date().toISOString()
    );
    return true;
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
    this.database.prepare(`
      INSERT OR IGNORE INTO whatsapp_capture_targets (
        instance_id, chat_jid, target_type
      )
      SELECT instance_id, ?, target_type
      FROM whatsapp_capture_targets
      WHERE instance_id = ? AND chat_jid = ?
    `).run(phoneJid, instanceId, lidJid);
    this.database.prepare(`
      DELETE FROM whatsapp_capture_targets
      WHERE instance_id = ? AND chat_jid = ?
    `).run(instanceId, lidJid);
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
    const rawRemoteJid = overrides.remoteJid || message?.key?.remoteJid;
    const participantJid =
      message?.key?.participantPn || message?.key?.participant || null;

    if (rawRemoteJid && (message?.pushName || message?.verifiedBizName)) {
      this.saveContact(instanceId, {
        id: rawRemoteJid,
        notify: message.pushName,
        verifiedName: message.verifiedBizName
      });
    }

    if (participantJid && (message?.pushName || message?.verifiedBizName)) {
      this.saveContact(instanceId, {
        id: participantJid,
        jid: isPhoneJid(message?.key?.participantPn)
          ? message.key.participantPn
          : undefined,
        lid: isLidJid(message?.key?.participant)
          ? message.key.participant
          : undefined,
        notify: message.pushName,
        verifiedName: message.verifiedBizName
      });
    }

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

    const messageTimestamp = toUnixSeconds(message.messageTimestamp);
    if (!this.shouldCaptureMessage(instanceId, remoteJid, messageTimestamp)) {
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
      participantJid,
      direction,
      getMessageType(content),
      text || null,
      messageTimestamp,
      safeJsonStringify(message),
      new Date().toISOString()
    );

    return true;
  }

  shouldCaptureMessage(instanceId, remoteJid, messageTimestamp) {
    const setting = this.selectCaptureModeStatement.get(instanceId);
    const mode = setting?.mode || "todo";
    const effectiveFrom = setting?.updated_at
      ? Math.floor(new Date(setting.updated_at).getTime() / 1000)
      : null;

    if (
      Number.isFinite(effectiveFrom) &&
      messageTimestamp < effectiveFrom
    ) {
      return false;
    }

    if (mode === "nada") {
      return false;
    }
    if (mode === "todo") {
      return true;
    }
    return Boolean(
      this.isCaptureTargetSelectedStatement.get(instanceId, remoteJid)
    );
  }

  getCaptureSettings(instanceId) {
    const setting = this.database
      .prepare(`
        SELECT mode, retention_days, updated_at
        FROM whatsapp_capture_settings
        WHERE instance_id = ?
      `)
      .get(instanceId);
    const selected = this.database
      .prepare(`
        SELECT chat_jid
        FROM whatsapp_capture_targets
        WHERE instance_id = ?
        ORDER BY chat_jid
      `)
      .all(instanceId)
      .map((row) => row.chat_jid);

    return {
      modo: setting?.mode || "todo",
      seleccionados: selected,
      retencionDias: setting?.retention_days ?? null,
      actualizadoEn: setting?.updated_at || null
    };
  }

  saveCaptureSettings(instanceId, mode, selected = [], retentionDays) {
    const validModes = new Set(["todo", "seleccionados", "nada"]);
    if (!validModes.has(mode)) {
      const error = new Error("modo debe ser todo, seleccionados o nada");
      error.statusCode = 400;
      throw error;
    }
    if (!Array.isArray(selected)) {
      const error = new Error("seleccionados debe ser una lista");
      error.statusCode = 400;
      throw error;
    }

    const targets = [...new Set(selected.map((value) => String(value).trim()))]
      .filter(Boolean)
      .map((id) => {
        if (id.endsWith("@g.us")) {
          return { id, type: "grupo" };
        }
        if (isPhoneJid(id) || isLidJid(id)) {
          return { id, type: "contacto" };
        }
        const error = new Error(`destino de captura invalido: ${id}`);
        error.statusCode = 400;
        throw error;
      });
    const normalizedTargets = mode === "seleccionados" ? targets : [];
    if (mode === "seleccionados" && normalizedTargets.length === 0) {
      const error = new Error(
        "debe seleccionar al menos un contacto o grupo"
      );
      error.statusCode = 400;
      throw error;
    }
    const current = this.getCaptureSettings(instanceId);
    let normalizedRetentionDays = retentionDays;
    if (normalizedRetentionDays === undefined) {
      normalizedRetentionDays = current.retencionDias;
    }
    if (normalizedRetentionDays !== null) {
      normalizedRetentionDays = Number(normalizedRetentionDays);
      if (
        !Number.isInteger(normalizedRetentionDays) ||
        normalizedRetentionDays < 1 ||
        normalizedRetentionDays > 3650
      ) {
        const error = new Error(
          "retencionDias debe ser null o un entero entre 1 y 3650"
        );
        error.statusCode = 400;
        throw error;
      }
    }
    const currentTargets = [...current.seleccionados].sort();
    const nextTargets = normalizedTargets.map((target) => target.id).sort();
    const policyChanged =
      current.modo !== mode ||
      currentTargets.length !== nextTargets.length ||
      currentTargets.some((target, index) => target !== nextTargets[index]);
    const updatedAt =
      policyChanged || !current.actualizadoEn
        ? new Date().toISOString()
        : current.actualizadoEn;
    this.replaceCaptureSettingsTransaction(
      instanceId,
      mode,
      {
        items: normalizedTargets,
        retentionDays: normalizedRetentionDays
      },
      updatedAt
    );
    return this.getCaptureSettings(instanceId);
  }

  deleteExpiredMessages(now = new Date()) {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const settings = this.database.prepare(`
      SELECT instance_id, retention_days
      FROM whatsapp_capture_settings
      WHERE retention_days IS NOT NULL
    `).all();
    const removeMessages = this.database.prepare(`
      DELETE FROM whatsapp_messages
      WHERE instance_id = ? AND message_timestamp < ?
    `);
    const removeOrphanLabels = this.database.prepare(`
      DELETE FROM whatsapp_conversation_labels
      WHERE instance_id = ?
        AND NOT EXISTS (
          SELECT 1
          FROM whatsapp_messages
          WHERE whatsapp_messages.instance_id = whatsapp_conversation_labels.instance_id
            AND whatsapp_messages.remote_jid = whatsapp_conversation_labels.remote_jid
        )
    `);
    const cleanup = this.database.transaction(() => {
      const instances = [];
      let total = 0;
      for (const setting of settings) {
        const cutoff = nowSeconds - setting.retention_days * 24 * 60 * 60;
        const deleted = removeMessages.run(setting.instance_id, cutoff).changes;
        removeOrphanLabels.run(setting.instance_id);
        total += deleted;
        instances.push({
          instancia: setting.instance_id,
          retencionDias: setting.retention_days,
          mensajesEliminados: deleted
        });
      }
      return { mensajesEliminados: total, instancias: instances };
    });
    return cleanup();
  }

  clearInbox(instanceId) {
    const deleted = this.clearInboxTransaction(instanceId);
    return {
      instancia: instanceId,
      mensajesEliminados: deleted.messages,
      etiquetasEliminadas: deleted.labels
    };
  }

  getCaptureTargets(instanceId) {
    const contactsById = new Map();
    const contacts = this.database.prepare(`
      SELECT contact_jid, phone_jid, lid_jid, saved_name, notify_name, verified_name
      FROM whatsapp_contacts
      WHERE instance_id = ?
    `).all(instanceId);

    for (const contact of contacts) {
      const id = contact.phone_jid || contact.lid_jid || contact.contact_jid;
      if (!isPhoneJid(id) && !isLidJid(id)) {
        continue;
      }
      const current = contactsById.get(id) || { id, tipo: "contacto" };
      current.nombreAgendado ||= contact.saved_name || null;
      current.nombrePerfil ||=
        contact.verified_name || contact.notify_name || null;
      current.nombre ||= current.nombreAgendado || current.nombrePerfil || null;
      contactsById.set(id, current);
    }

    const groups = this.database.prepare(`
      SELECT group_jid AS id, subject AS nombre
      FROM whatsapp_groups
      WHERE instance_id = ?
      ORDER BY subject COLLATE NOCASE, group_jid
    `).all(instanceId).map((group) => ({ ...group, tipo: "grupo" }));

    return {
      contactos: [...contactsById.values()].sort((left, right) =>
        String(left.nombre || left.id).localeCompare(
          String(right.nombre || right.id),
          "es"
        )
      ),
      grupos: groups
    };
  }

  getMessagesForRange(instanceId, startSeconds, endSeconds, chatIds = []) {
    const normalizedChatIds = [
      ...new Set(
        (Array.isArray(chatIds) ? chatIds : [chatIds])
          .map((chatId) => String(chatId || "").trim())
          .filter(Boolean)
      )
    ];
    const statement = normalizedChatIds.length
      ? this.database.prepare(`
          SELECT
            message_id,
            remote_jid,
            participant_jid,
            direction,
            message_type,
            text,
            message_timestamp,
            CASE
              WHEN json_valid(raw_message)
              THEN json_extract(raw_message, '$.pushName')
              ELSE NULL
            END AS push_name,
            CASE
              WHEN json_valid(raw_message)
              THEN json_extract(raw_message, '$.verifiedBizName')
              ELSE NULL
            END AS verified_biz_name,
            captured_at
          FROM whatsapp_messages
          WHERE instance_id = ?
            AND message_timestamp >= ?
            AND message_timestamp < ?
            AND remote_jid <> 'status@broadcast'
            AND remote_jid NOT LIKE '%@newsletter'
            AND remote_jid IN (${normalizedChatIds.map(() => "?").join(", ")})
          ORDER BY message_timestamp ASC, message_id ASC
        `)
      : this.selectRangeStatement;

    return statement
      .all(instanceId, startSeconds, endSeconds, ...normalizedChatIds)
      .map((row) => ({
        id: row.message_id,
        chat: row.remote_jid,
        participante: row.participant_jid,
        direccion: row.direction,
        tipo: row.message_type,
        texto: row.text,
        nombrePerfil: row.verified_biz_name || row.push_name || null,
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
    { from, to, chatIds = [], now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}
  ) {
    const today = getDayWindow(now, timeZone).date;
    const range = getDateRangeWindow(from || today, to || from || today, timeZone);
    const messages = this.getMessagesForRange(
      instanceId,
      range.startSeconds,
      range.endSeconds,
      chatIds
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
      const group = conversation.esGrupo
        ? this.selectGroupStatement.get(instanceId, conversation.chat)
        : null;
      const contact = this.selectContactStatement.get(
        instanceId,
        conversation.chat,
        conversation.chat,
        conversation.chat
      );
      const phoneJid = isPhoneJid(conversation.chat)
        ? conversation.chat
        : contact?.phone_jid;

      if (conversation.esGrupo) {
        conversation.nombreGrupo = group?.subject || null;
        conversation.nombre = conversation.nombreGrupo;
        conversation.mensajes.forEach((message) => {
          if (!message.participante) return;
          const participantContact = this.selectContactStatement.get(
            instanceId,
            message.participante,
            message.participante,
            message.participante
          );
          const participantPhoneJid = isPhoneJid(message.participante)
            ? message.participante
            : participantContact?.phone_jid;
          message.telefonoParticipante = participantPhoneJid
            ? getChatNumber(participantPhoneJid)
            : null;
          message.nombreParticipante =
            participantContact?.saved_name ||
            participantContact?.verified_name ||
            participantContact?.notify_name ||
            message.nombrePerfil ||
            null;
        });
      } else {
        conversation.esLid = isLidJid(conversation.chat) && !phoneJid;
        conversation.telefono = phoneJid ? getChatNumber(phoneJid) : null;
        if (phoneJid) {
          conversation.numero = conversation.telefono;
        }
        conversation.nombreAgendado = contact?.saved_name || null;
        conversation.nombrePerfil =
          contact?.verified_name ||
          contact?.notify_name ||
          conversation.mensajes.find((message) => message.nombrePerfil)
            ?.nombrePerfil ||
          null;
        conversation.nombre =
          conversation.nombreAgendado || conversation.nombrePerfil || null;
      }
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
  isLidJid,
  isPhoneJid,
  toUnixSeconds,
  unwrapMessageContent
};
