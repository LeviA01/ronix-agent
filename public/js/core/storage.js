function userKey(key) {
  const user = globalThis.ronixAccess?.user;
  return user ? `ronix-user:${user.id}:${key}` : key;
}

export function loadStoredJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(userKey(key)) ?? "null");
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

export function storeJson(key, value) {
  localStorage.setItem(userKey(key), JSON.stringify(value));
}

export function storeString(key, value) {
  localStorage.setItem(userKey(key), value);
}

export function loadString(key, fallback = "") {
  return localStorage.getItem(userKey(key)) ?? fallback;
}
