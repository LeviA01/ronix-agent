export function headers(json = false) {
  const result = {};
  if (json) result["content-type"] = "application/json";
  return result;
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers(Boolean(options.body)), ...options.headers },
  });
  const body = response.status === 204 ? null : await response.json();
  if (response.status === 401) {
    location.replace("/login");
    throw new Error("Требуется вход");
  }
  if (!response.ok) {
    const error = new Error(body.error ?? `HTTP ${response.status}`);
    if (body && typeof body === "object") Object.assign(error, body);
    throw error;
  }
  return body;
}
