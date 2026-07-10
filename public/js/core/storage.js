export function loadStoredJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

export function storeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function storeString(key, value) {
  localStorage.setItem(key, value);
}

export function loadString(key, fallback = "") {
  return localStorage.getItem(key) ?? fallback;
}
