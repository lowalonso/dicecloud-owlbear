// Cartão de notificação: mostra as últimas rolagens/usos recebidos pela URL.
import OBR from "https://esm.sh/@owlbear-rodeo/sdk@3";
import { TOAST_ID } from "./dicecloud.js";

let entries = [];
try { entries = JSON.parse(new URLSearchParams(location.search).get("d")) || []; } catch { /* sem dados */ }

const D20 = (fill) => `<svg viewBox="0 0 54 54" aria-hidden="true">
  <polygon points="27,2 49,14.5 49,39.5 27,52 5,39.5 5,14.5" fill="${fill}"/>
  <polygon points="27,2 49,14.5 49,39.5 27,52 5,39.5 5,14.5" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.5"/>
</svg>`;
const SPARK = `<svg viewBox="0 0 44 44" aria-hidden="true">
  <circle cx="22" cy="22" r="21" fill="#ffd27a"/>
  <path d="M22 9l3 8.5 8.5 3-8.5 3L22 32l-3-8.5-8.5-3 8.5-3z" fill="#3a2a07"/>
</svg>`;

function div(className, text) {
  const node = document.createElement("div");
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

for (const entry of entries) {
  const isUse = entry.kind === "use";
  const crit = entry.nat === 20, fumble = entry.nat === 1;
  const card = div(`card ${isUse ? "use" : crit ? "crit" : fumble ? "fumble" : ""}`);

  const badge = div("badge");
  if (isUse && entry.avatar) {
    badge.classList.add("portrait");
    badge.style.backgroundImage = `url("${String(entry.avatar).replace(/"/g, "%22")}")`;
  } else {
    badge.innerHTML = isUse ? SPARK : D20(crit ? "#6fdc96" : fumble ? "#ff8a8a" : "#bb99ff");
    if (!isUse) badge.append(Object.assign(document.createElement("span"), { textContent: String(entry.total) }));
  }

  const body = div("body");
  const who = div("who");
  const name = document.createElement("b");
  name.textContent = entry.character || "";
  who.append(name, entry.player ? ` · ${entry.player}` : "");
  body.append(who);

  if (isUse) {
    body.append(div("label", entry.label.charAt(0).toUpperCase() + entry.label.slice(1)));
    if (entry.sub) body.append(div("detail", entry.sub));
    if (entry.text) body.append(div("text", entry.text));
  } else {
    const label = div("label", entry.label);
    if (crit || fumble) label.append(Object.assign(document.createElement("span"), { className: "tag", textContent: crit ? "crítico" : "falha" }));
    body.append(label, div("detail", `${entry.detail} = ${entry.total}`));
  }
  card.append(badge, body);
  document.body.append(card);
}

if (OBR.isAvailable) {
  OBR.onReady(() => {
    OBR.popover.setHeight(TOAST_ID, Math.ceil(document.documentElement.scrollHeight));
    document.body.addEventListener("click", () => OBR.popover.close(TOAST_ID));
  });
}
