const crypto = require("node:crypto");
const path = require("node:path");
const Database = require("better-sqlite3");

const DEFAULT_TTL_HOURS = 23;

function conversationError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.isOperational = true;
  return error;
}

function parseTtlHours(value) {
  const hours = Number(value);
  return Number.isFinite(hours) && hours > 0
    ? hours
    : DEFAULT_TTL_HOURS;
}

function normalizeChatId(value) {
  const chatId = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(chatId)) {
    throw conversationError(
      "chatId no es valido",
      400,
      "CHAT_ID_INVALIDO"
    );
  }
  return chatId;
}

class GeminiConversationStore {
  constructor(options = {}) {
    this.databaseFile =
      options.databaseFile ||
      path.join(__dirname, "..", "data", "gemini-conversations.sqlite");
    this.ttlMs =
      parseTtlHours(options.ttlHours ?? process.env.IA_CHAT_TTL_HOURS) *
      60 * 60 * 1000;
    this.database = new Database(this.databaseFile);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS gemini_conversations (
        chat_id TEXT PRIMARY KEY,
        latest_interaction_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        requested_model_name TEXT NOT NULL,
        catalog_store_name TEXT,
        file_search_stores_json TEXT NOT NULL,
        response_format TEXT NOT NULL,
        response_schema_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gemini_conversations_expires
        ON gemini_conversations (expires_at);
    `);
    const columnas = this.database
      .prepare("PRAGMA table_info(gemini_conversations)")
      .all();
    if (!columnas.some((columna) => columna.name === "response_schema_json")) {
      this.database.exec(
        "ALTER TABLE gemini_conversations ADD COLUMN response_schema_json TEXT"
      );
    }
    this.insertConversation = this.database.prepare(`
      INSERT INTO gemini_conversations (
        chat_id,
        latest_interaction_id,
        model_name,
        requested_model_name,
        catalog_store_name,
        file_search_stores_json,
        response_format,
        response_schema_json,
        created_at,
        updated_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.selectConversation = this.database.prepare(`
      SELECT * FROM gemini_conversations WHERE chat_id = ?
    `);
    this.advanceConversation = this.database.prepare(`
      UPDATE gemini_conversations
      SET latest_interaction_id = ?,
          model_name = ?,
          updated_at = ?,
          expires_at = ?
      WHERE chat_id = ? AND latest_interaction_id = ?
    `);
    this.deleteConversation = this.database.prepare(`
      DELETE FROM gemini_conversations WHERE chat_id = ?
    `);
    this.deleteExpired = this.database.prepare(`
      DELETE FROM gemini_conversations WHERE expires_at <= ?
    `);
  }

  expirationFrom(date) {
    return new Date(date.getTime() + this.ttlMs).toISOString();
  }

  deserialize(row) {
    return {
      chatId: row.chat_id,
      latestInteractionId: row.latest_interaction_id,
      modelName: row.model_name,
      requestedModelName: row.requested_model_name,
      catalogStoreName: row.catalog_store_name || null,
      fileSearchStoreNames: JSON.parse(row.file_search_stores_json),
      formatoRespuesta: row.response_format,
      esquemaRespuesta: row.response_schema_json
        ? JSON.parse(row.response_schema_json)
        : undefined,
      creadoEn: row.created_at,
      actualizadoEn: row.updated_at,
      expiraEn: row.expires_at
    };
  }

  create({
    latestInteractionId,
    modelName,
    requestedModelName,
    catalogStoreName,
    fileSearchStoreNames,
    formatoRespuesta,
    esquemaRespuesta
  }) {
    const chatId = crypto.randomUUID();
    const now = new Date();
    const timestamp = now.toISOString();
    this.deleteExpired.run(timestamp);
    this.insertConversation.run(
      chatId,
      latestInteractionId,
      modelName,
      requestedModelName,
      catalogStoreName || null,
      JSON.stringify(fileSearchStoreNames || []),
      formatoRespuesta,
      esquemaRespuesta === undefined
        ? null
        : JSON.stringify(esquemaRespuesta),
      timestamp,
      timestamp,
      this.expirationFrom(now)
    );
    return this.get(chatId);
  }

  get(value) {
    const chatId = normalizeChatId(value);
    const row = this.selectConversation.get(chatId);
    if (!row) {
      throw conversationError(
        "La conversacion no existe o ya expiro",
        404,
        "CHAT_NO_ENCONTRADO"
      );
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.deleteConversation.run(chatId);
      throw conversationError(
        "La conversacion expiro; inicia una nueva y vuelve a adjuntar los archivos",
        410,
        "CHAT_EXPIRADO"
      );
    }
    return this.deserialize(row);
  }

  advance(chatIdValue, previousInteractionId, nextInteractionId, modelName) {
    const chatId = normalizeChatId(chatIdValue);
    const now = new Date();
    const result = this.advanceConversation.run(
      nextInteractionId,
      modelName,
      now.toISOString(),
      this.expirationFrom(now),
      chatId,
      previousInteractionId
    );
    if (result.changes !== 1) {
      throw conversationError(
        "La conversacion recibio dos respuestas al mismo tiempo; vuelve a intentar",
        409,
        "CHAT_CONCURRENCIA"
      );
    }
    return this.get(chatId);
  }

  delete(value) {
    const chatId = normalizeChatId(value);
    return this.deleteConversation.run(chatId).changes > 0;
  }

  close() {
    this.database.close();
  }
}

const geminiConversationStore = new GeminiConversationStore();

module.exports = {
  DEFAULT_TTL_HOURS,
  GeminiConversationStore,
  geminiConversationStore,
  normalizeChatId
};
