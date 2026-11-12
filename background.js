// Roda em segundo plano para todo mundo na sala: mostra cada rolagem ou uso como um
// cartão no topo da tela e guarda o histórico, mesmo com o painel da extensão fechado.
import OBR from "https://esm.sh/@owlbear-rodeo/sdk@3";
import { CHANNEL, LOG_KEY, TOAST_ID, formatRoll } from "./dicecloud.js";

const TOAST_MS = 7000;
const TOAST_URL = new URL("./toast.html", location.href).href;
let recent = [];
let closeTimer;

async function showToast(entry) {
  const now = Date.now();
  recent = [...recent.filter((e) => now - e.shownAt < TOAST_MS), { ...entry, shownAt: now }].slice(-3);
  const width = await OBR.viewport.getWidth();
  try { await OBR.popover.close(TOAST_ID); } catch { /* não estava aberto */ }
  await OBR.popover.open({
    id: TOAST_ID,
    url: `${TOAST_URL}?d=${encodeURIComponent(JSON.stringify(recent))}`,
    width: 380,
    height: 110 * recent.length, // o próprio cartão ajusta a altura depois de carregar
    anchorReference: "POSITION",
    anchorPosition: { left: Math.round(width / 2), top: 64 },
    anchorOrigin: { horizontal: "CENTER", vertical: "TOP" },
    transformOrigin: { horizontal: "CENTER", vertical: "TOP" },
    disableClickAway: true,
    hidePaper: true,
    marginThreshold: 8,
  });
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    recent = [];
    OBR.popover.close(TOAST_ID);
  }, TOAST_MS);
}

OBR.onReady(() => {
  OBR.broadcast.onMessage(CHANNEL, async (event) => {
    const entry = event.data;
    try {
      const log = JSON.parse(localStorage.getItem(LOG_KEY)) ?? [];
      log.push(entry);
      localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-30)));
    } catch { /* armazenamento indisponível */ }
    try {
      await showToast(entry);
    } catch {
      // Se o cartão não abrir, cai na notificação simples do Owlbear.
      const who = entry.player ? `${entry.player} — ` : "";
      OBR.notification.show(`${who}${formatRoll(entry)}`, entry.nat === 20 ? "SUCCESS" : entry.nat === 1 ? "ERROR" : "INFO");
    }
  });
});
