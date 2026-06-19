const form = document.querySelector("#login-form");
const keyInput = document.querySelector("#key");
const submit = document.querySelector("#submit");
const error = document.querySelector("#error");
const toggle = document.querySelector("#toggle-key");

toggle.addEventListener("click", () => {
  const visible = keyInput.type === "text";
  keyInput.type = visible ? "password" : "text";
  toggle.textContent = visible ? "Показать" : "Скрыть";
  toggle.setAttribute("aria-label", visible ? "Показать ключ" : "Скрыть ключ");
  keyInput.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  submit.disabled = true;
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: keyInput.value }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Не удалось войти");
    keyInput.value = "";
    location.replace("/");
  } catch (reason) {
    error.textContent = reason instanceof Error ? reason.message : String(reason);
    error.hidden = false;
    keyInput.select();
  } finally {
    submit.disabled = false;
  }
});

fetch("/api/auth/status")
  .then((response) => response.json())
  .then(({ authenticated }) => { if (authenticated) location.replace("/"); })
  .catch(() => {});
