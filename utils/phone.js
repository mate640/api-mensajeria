function normalizeArMobileNumber(numero) {
  const digits = String(numero || "").replace(/\D/g, "");

  if (!digits) {
    throw new Error("Numero invalido");
  }

  if (digits.startsWith("549")) {
    return digits;
  }

  if (digits.length === 10) {
    return `549${digits}`;
  }

  return digits;
}

module.exports = {
  normalizeArMobileNumber
};
