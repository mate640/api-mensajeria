const DEFAULT_TIMEOUT_MS = 10_000;

function configuredBaseUrl() {
  return String(process.env.FIREBIRD_API_URL || '').trim().replace(/\/+$/, '');
}

function configuredKey() {
  return String(process.env.FIREBIRD_API_KEY || '').trim();
}

function serviceError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.isOperational = true;
  return error;
}

async function listPrompts() {
  const baseUrl = configuredBaseUrl();
  const apiKey = configuredKey();
  if (!baseUrl || !apiKey) {
    throw serviceError(
      'La consulta de prompts de API Firebird no está configurada',
      503,
      'FIREBIRD_PROMPTS_NO_CONFIGURADO',
    );
  }

  let response;
  try {
    response = await fetch(`${baseUrl}/api/internal/asistente-ia/prompts`, {
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw serviceError(
      error?.name === 'TimeoutError'
        ? 'API Firebird demoró demasiado en responder'
        : 'No se pudo conectar con API Firebird',
      502,
      'FIREBIRD_PROMPTS_NO_DISPONIBLE',
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw serviceError(
      'API Firebird devolvió una respuesta inválida',
      502,
      'FIREBIRD_PROMPTS_RESPUESTA_INVALIDA',
    );
  }
  if (!response.ok) {
    throw serviceError(
      body?.error || 'API Firebird rechazó la consulta de prompts',
      response.status === 401 || response.status === 403 ? 502 : response.status,
      body?.codigo || 'FIREBIRD_PROMPTS_ERROR',
    );
  }

  const prompts = Array.isArray(body?.prompts) ? body.prompts : [];
  return prompts
    .filter((prompt) => prompt && typeof prompt.texto === 'string')
    .map((prompt) => ({
      id: Number(prompt.id),
      tipo: String(prompt.tipo || '').trim(),
      version: Number(prompt.version),
      texto: prompt.texto,
      actualizadoEn: prompt.actualizadoEn || null,
    }));
}

module.exports = { listPrompts };
