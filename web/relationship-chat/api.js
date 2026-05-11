export async function readJsonResponse(response, fallbackMessage) {
  const text = await response.text();
  const data = parseJsonBody(text);

  if (!response.ok) {
    const message = data?.message ?? httpErrorMessage(response, fallbackMessage);
    throw new Error(message);
  }

  if (data === null) {
    throw new Error(`${fallbackMessage}：响应为空`);
  }

  return data;
}

function parseJsonBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function httpErrorMessage(response, fallbackMessage) {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return `${fallbackMessage}：HTTP ${response.status}${statusText}`;
}
