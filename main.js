import OBR from "https://esm.sh/@owlbear-rodeo/sdk@3";
import {
  CHANNEL, LOG_KEY, extractCreatureId, fetchCreatureText, parseCreature, login,
  rollD20, d20Result, rollNotation, fmtMod, clip,
} from "./dicecloud.js";
import { createSync } from "./ddp.js";

const CFG_KEY = "dicecloud-roller/config";
const OVR_KEY = "dicecloud-roller/counters";
const REFRESH_MS = 60000;

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* armazenamento indisponível */ }
  },
};

let config = store.get(CFG_KEY, { link: "", token: "", proxy: "" });
let sheet = null;
let lastText = "";
let mode = "normal";
let tab = "ficha";
let onlyPrepared = true;
let hpTarget = "hp"; // "hp" ou "temp": onde os botões de vida atuam
const openEntries = new Set(); // cartões expandidos (sobrevivem ao redesenho)
let log = store.get(LOG_KEY, []);

// ---------- Traduções ----------

const ABILITY_ABBR = { strength: "FOR", dexterity: "DES", constitution: "CON", intelligence: "INT", wisdom: "SAB", charisma: "CAR" };
const ABILITY_ORDER = Object.keys(ABILITY_ABBR);
const DAMAGE_PT = {
  slashing: "cortante", piercing: "perfurante", bludgeoning: "contundente", fire: "fogo", cold: "frio",
  lightning: "elétrico", thunder: "trovejante", poison: "veneno", acid: "ácido", necrotic: "necrótico",
  radiant: "radiante", force: "energia", psychic: "psíquico", healing: "cura", temporary: "vida temporária",
};
const SCHOOL_PT = {
  abjuration: "Abjuração", conjuration: "Conjuração", divination: "Adivinhação", enchantment: "Encantamento",
  evocation: "Evocação", illusion: "Ilusão", necromancy: "Necromancia", transmutation: "Transmutação",
};
const ACTION_TYPES = { action: "Ação", bonus: "Ação bônus", attack: "Ataque", reaction: "Reação", free: "Livre", long: "Longa" };
const CAST_PT = { action: "1 ação", bonus: "1 ação bônus", reaction: "1 reação", free: "livre" };
const damagePt = (t) => DAMAGE_PT[t] || t || "";
const abilityOf = (key = "") => ABILITY_ORDER.find((k) => key.toLowerCase().startsWith(k));

// ---------- Utilidades de interface ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v; // só com SVG fixo do próprio código
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null && !(k === "disabled" && !v)) node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false && c !== ""));
  return node;
}

const ICONS = {
  chev: '<path d="M9 6l6 6-6 6"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  d20: '<path d="M12 2l8.66 5v10L12 22l-8.66-5V7z"/><path d="M12 2v6m0 0l8.66-1M12 8L3.34 7M12 8l5.2 9M12 8l-5.2 9m0 0h10.4M3.34 17l3.46 0M20.66 17h-3.46M12 22v-5"/>',
};
const icon = (name, cls = "") => el("span", { class: `ico ${cls}`, html: `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${ICONS[name]}</svg>` }).firstChild;

let statusTimer;
function setStatus(text, isError = false, html = null) {
  const box = $("status");
  clearTimeout(statusTimer);
  if (!text && !html) { box.hidden = true; return; }
  box.className = `snackbar${isError ? " error" : ""}${html ? " result" : ""}`;
  box.replaceChildren(...(html || [text]));
  box.hidden = false;
  if (!isError) statusTimer = setTimeout(() => { box.hidden = true; }, 3500);
}

const sectionTitle = (text, ...extra) => el("div", { class: "section-title" }, el("span", { text }), ...extra);

/** Cartão de ação, magia ou item: cabeçalho clicável que expande os detalhes. */
function entryCard({ key, title, tags = [], sub = "", use, body = [] }) {
  const content = body.filter(Boolean);
  const isOpen = openEntries.has(key);
  const card = el("div", { class: `entry${isOpen ? " open" : ""}` });
  const toggle = () => {
    if (!content.length) return;
    if (openEntries.has(key)) openEntries.delete(key); else openEntries.add(key);
    render();
  };
  card.append(el("div", { class: "entry-head" },
    el("button", { class: "entry-main", onclick: toggle, "aria-expanded": content.length ? String(isOpen) : false },
      el("span", { class: "entry-title" },
        el("span", { text: title }),
        ...tags.filter(Boolean).map((t) => el("span", { class: `tag ${t.cls || ""}`, text: t.text || t })),
        content.length ? icon("chev", "chev") : null),
      sub && el("span", { class: "entry-sub", text: sub })),
    use || null));
  if (isOpen && content.length) card.append(el("div", { class: "entry-body" }, content));
  return card;
}

/** Botões de ataque e dano de uma ação ou magia. */
function rollChips(a) {
  const chips = [];
  if (a.attackBonus != null) {
    chips.push(el("button", { class: "chip-btn", onclick: () => rollCheck(`${a.name} (ataque)`, a.attackBonus, 0) },
      icon("d20"), `Ataque ${fmtMod(a.attackBonus)}`));
  }
  for (const d of a.damages) {
    const type = damagePt(d.damageType);
    const heal = d.damageType === "healing" || d.damageType === "temporary";
    chips.push(d.notation
      ? el("button", { class: `chip-btn${heal ? " heal" : ""}`, onclick: () => rollDice(dmgLabel(a, d), d.notation) },
          d.amount.replace(/\s+/g, ""), type && el("small", { text: type }))
      : el("span", { class: "tag", text: `${d.amount} ${type}` }));
  }
  return chips.length ? el("div", { class: "actions" }, chips) : null;
}

/** Linha-resumo de ataque/dano para o subtítulo do cartão. */
function rollSummary(a) {
  const parts = [];
  if (a.attackBonus != null) parts.push(`${fmtMod(a.attackBonus)} para acertar`);
  for (const d of a.damages) parts.push(`${d.amount.replace(/\s+/g, "")} ${damagePt(d.damageType)}`.trim());
  return parts.join(" · ");
}

// ---------- Contadores (vida, espaços de magia, recursos, usos) ----------
// Cada ajuste aparece na hora e fica guardado neste navegador. Com login no DiceCloud,
// também é gravado na ficha; quando a ficha muda lá, o valor do DiceCloud volta a valer.

let overrides = store.get(OVR_KEY, {}); // { idDaPropriedade: { v: valor, base: valor do DiceCloud na hora } }
const sync = createSync(() => config.token);
const writeTimers = new Map();
const inflight = new Set();

function counter(id, base) {
  const o = overrides[id];
  return o && o.base === base ? o.v : base;
}

function setCounter(id, field, base, value) {
  overrides[id] = { v: value, base };
  store.set(OVR_KEY, overrides);
  render();
  if (!config.token || id.startsWith("local-")) return;
  clearTimeout(writeTimers.get(id));
  inflight.add(id);
  writeTimers.set(id, setTimeout(async () => {
    try {
      await sync.update(id, [field], overrides[id]?.v ?? value);
    } catch (err) {
      setStatus(`Não salvei no DiceCloud: ${err.message}`, true);
    } finally {
      inflight.delete(id);
    }
  }, 600));
}

const allPools = (s) => [...s.healthBars, ...s.hitDice, ...s.resources, ...s.spellSlots];
const allActions = (s) => [...s.actions, ...s.spells, ...s.items.flatMap((i) => i.actions)];

/** Depois de recarregar a ficha: descarta ajustes locais que o DiceCloud já superou. */
function pruneOverrides(s) {
  const bases = new Map([...allPools(s).map((p) => [p.id, p.damage]), ...allActions(s).map((a) => [a.id, a.usesUsed])]);
  for (const [id, o] of Object.entries(overrides)) {
    if (!bases.has(id)) delete overrides[id];
    else if (o.base !== bases.get(id)) {
      if (inflight.has(id)) o.base = bases.get(id); // gravação em andamento: mantém o valor local
      else delete overrides[id];
    }
  }
  store.set(OVR_KEY, overrides);
}

const poolDamage = (p) => counter(p.id, p.damage);
const poolValue = (p) => p.total - poolDamage(p);
/** delta positivo recupera, negativo gasta. */
function changePool(p, delta) {
  const min = p.ignoreUpper ? -9999 : 0; // vida temporária pode passar do total
  const max = p.ignoreLower ? 9999 : p.total;
  const damage = Math.max(min, Math.min(max, poolDamage(p) - delta));
  if (damage !== poolDamage(p)) setCounter(p.id, "damage", p.damage, damage);
}
const setPoolValue = (p, value) => changePool(p, value - poolValue(p));
const usesLeft = (a) => a.usesTotal - counter(a.id, a.usesUsed);

/** Gasta o que a ação ou magia consome. Devolve um aviso se faltar algo (não bloqueia o uso). */
function spendFor(a) {
  const warnings = [];
  if (a.level > 0 && !a.noSlot) {
    const slot = sheet.spellSlots.find((x) => x.level === a.level);
    if (slot && poolValue(slot) > 0) changePool(slot, -1);
    else warnings.push(`sem espaço de ${a.level}º círculo (se conjurou em círculo maior, gaste a bolinha na aba Magias)`);
  }
  if (a.usesTotal) {
    if (usesLeft(a) > 0) setCounter(a.id, "usesUsed", a.usesUsed, counter(a.id, a.usesUsed) + 1);
    else warnings.push("sem usos restantes");
  }
  for (const c of a.consumes) {
    const p = allPools(sheet).find((x) => x.key === c.key);
    if (!p) continue;
    if (poolValue(p) >= c.quantity) changePool(p, -c.quantity);
    else warnings.push(`${p.name} insuficiente`);
  }
  return warnings.length ? `${a.name}: ${warnings.join("; ")}.` : "";
}

const isTemp = (p) => p.ignoreUpper || p.local;
const mainHp = () => sheet.healthBars.find((p) => !isTemp(p));
const tempHp = () => sheet.healthBars.find(isTemp);

function rest(kind) {
  const names = kind === "long" ? ["longRest", "shortRest"] : ["shortRest"];
  const pools = allPools(sheet).filter((p) =>
    names.includes(p.reset) || (kind === "long" && (sheet.healthBars.includes(p) || sheet.spellSlots.includes(p))));
  // Vida temporária tem "dano" negativo; o descanso longo também a zera.
  for (const p of pools) if (poolDamage(p) > 0 || (isTemp(p) && poolDamage(p) < 0)) setCounter(p.id, "damage", p.damage, 0);
  for (const a of allActions(sheet)) {
    if (a.usesTotal && names.includes(a.reset) && counter(a.id, a.usesUsed) > 0) setCounter(a.id, "usesUsed", a.usesUsed, 0);
  }
  announce(kind === "long" ? "faz um descanso longo" : "faz um descanso curto");
}

/** Dano na vida normal consome primeiro a vida temporária. */
function hurt(amount) {
  let left = amount;
  const t = tempHp();
  if (t) {
    const absorbed = Math.min(left, Math.max(0, poolValue(t)));
    if (absorbed > 0) { changePool(t, -absorbed); left -= absorbed; }
  }
  const hp = mainHp();
  if (left > 0 && hp) changePool(hp, -left);
}

/** Bolinhas clicáveis: cheia = disponível. Clicar gasta ou recupera até aquela. */
function pips(p, label) {
  const value = poolValue(p);
  return el("div", { class: "pips", role: "group", "aria-label": `${label}: ${value} de ${p.total}` },
    Array.from({ length: p.total }, (_, i) => {
      const filled = i < value;
      return el("button", {
        class: `pip${filled ? "" : " used"}`,
        title: filled ? "Gastar" : "Recuperar",
        "aria-label": `${filled ? "Gastar" : "Recuperar"} ${label}`,
        onclick: () => setPoolValue(p, filled ? i : i + 1),
      });
    }));
}

function stepper(p, label) {
  return el("div", { class: "stepper" },
    el("button", { text: "−", "aria-label": `Gastar ${label}`, onclick: () => changePool(p, -1) }),
    el("b", { text: `${poolValue(p)} / ${p.total}` }),
    el("button", { text: "+", "aria-label": `Recuperar ${label}`, onclick: () => changePool(p, 1) }));
}
const counterFor = (p, label) => (p.total > 0 && p.total <= 12 ? pips(p, label) : stepper(p, label));

// ---------- Blocos da ficha ----------

function quickStats(s) {
  const find = (list, ...keys) => list.find((x) => keys.some((k) => x.key === k || x.name?.toLowerCase() === k));
  const ac = find(s.stats, "armor", "armorClass", "ac", "armor class", "classe de armadura");
  const speed = find(s.stats, "speed", "walkingSpeed", "deslocamento");
  const prof = find(s.modifiers, "proficiencyBonus", "proficiency bonus");
  const init = find(s.checks, "initiative", "iniciativa");
  const tiles = [];
  if (ac) tiles.push(el("div", { class: "stat" }, el("b", { text: String(ac.value) }), el("span", { text: "CA" })));
  if (init) {
    tiles.push(el("button", { class: "stat", title: "Rolar iniciativa", onclick: () => rollCheck("Iniciativa", init.mod, init.advantage) },
      el("b", { text: fmtMod(init.mod) }), el("span", { text: "Iniciativa" })));
  }
  if (speed) tiles.push(el("div", { class: "stat" }, el("b", { text: String(speed.value) }), el("span", { text: "Desloc." })));
  if (prof) tiles.push(el("div", { class: "stat" }, el("b", { text: fmtMod(prof.value) }), el("span", { text: "Profic." })));
  return tiles;
}

function hpCard() {
  const hp = mainHp();
  const t = tempHp();
  if (!hp && !t) return null;
  const value = hp ? poolValue(hp) : 0;
  const temp = t ? Math.max(0, poolValue(t)) : 0;
  const pct = hp && hp.total > 0 ? Math.max(0, Math.min(100, (value / hp.total) * 100)) : 0;
  const tempPct = hp && hp.total > 0 ? Math.min(100, (temp / hp.total) * 100) : 0;
  const onTemp = hpTarget === "temp" && t;
  const apply = (n) => {
    if (onTemp) changePool(t, n);
    else if (n < 0) hurt(-n);
    else if (hp) changePool(hp, n);
  };
  return el("div", { class: "card hp-card" },
    el("div", { class: "hp-head" },
      el("span", { class: "hp-now", text: String(value) }),
      hp && el("span", { class: "hp-max", text: `/ ${hp.total}` }),
      temp > 0 && el("span", { class: "temp-badge", title: "Vida temporária" }, icon("shield"), `+${temp}`),
      el("span", { class: "hp-label", text: "Pontos de vida" })),
    hp && el("div", { class: "bar", role: "img", "aria-label": `${value} de ${hp.total} pontos de vida` },
      el("div", { class: `fill${pct <= 25 ? " low" : pct <= 50 ? " mid" : ""}`, style: `width:${pct}%` }),
      tempPct > 0 && el("div", { class: "temp", style: `left:${pct}%;width:${Math.min(tempPct, 100 - pct)}%` })),
    t && el("div", { class: "hp-target", role: "radiogroup", "aria-label": "Os botões alteram" },
      el("button", { class: !onTemp ? "active" : "", role: "radio", "aria-checked": String(!onTemp), text: "Vida", onclick: () => { hpTarget = "hp"; render(); } }),
      el("button", { class: onTemp ? "active temp" : "temp", role: "radio", "aria-checked": String(!!onTemp), text: "Temporária", onclick: () => { hpTarget = "temp"; render(); } })),
    el("div", { class: `hp-grid${onTemp ? " temp" : ""}` },
      [-10, -5, -1, 1, 5, 10].map((n) => el("button", {
        class: n < 0 ? "hurt" : "heal",
        text: n < 0 ? `−${-n}` : `+${n}`,
        "aria-label": `${n < 0 ? "Tirar" : "Somar"} ${Math.abs(n)} ${onTemp ? "de vida temporária" : "de vida"}`,
        onclick: () => apply(n),
      }))));
}

function abilityCards(s) {
  if (!s.abilities.length) return [];
  const saveOf = (key) => s.saves.find((x) => abilityOf(x.key) === key);
  return [
    sectionTitle("Atributos", el("span", { class: "note small", text: "toque para rolar" })),
    el("div", { class: "abilities" }, s.abilities.map((a) => {
      const save = saveOf(a.key);
      return el("div", { class: "ability" },
        el("span", { class: "abbr", text: ABILITY_ABBR[a.key] || a.name.slice(0, 3).toUpperCase() }),
        el("button", { class: "check", title: `Teste de ${a.name}`, onclick: () => rollCheck(`Teste de ${a.name}`, a.mod) , text: fmtMod(a.mod) }),
        el("span", { class: "score", text: String(a.score) }),
        save && el("button", {
          class: `save${save.proficiency > 0 ? " prof" : ""}`,
          title: `Resistência de ${a.name}`,
          onclick: () => rollCheck(`Resistência de ${a.name}`, save.mod, save.advantage),
          text: `Resist. ${fmtMod(save.mod)}`,
        }));
    })),
  ];
}

function skillList(s) {
  if (!s.skills.length) return [];
  const dot = (p) => (p >= 2 ? "expert" : p >= 1 ? "full" : p > 0 ? "half" : "");
  return [
    sectionTitle("Perícias"),
    el("div", { class: "skills" }, s.skills.map((k) => el("button", {
      class: `skill${k.advantage > 0 ? " adv" : k.advantage < 0 ? " dis" : ""}`,
      title: k.advantage > 0 ? "Vantagem pela ficha" : k.advantage < 0 ? "Desvantagem pela ficha" : `Rolar ${k.name}`,
      onclick: () => rollCheck(k.name, k.mod, k.advantage),
    },
      el("span", { class: `dot ${dot(k.proficiency)}` }),
      el("span", { class: "name" }, k.name, ABILITY_ABBR[k.ability] && el("small", { text: ABILITY_ABBR[k.ability] })),
      el("span", { class: "mod", text: fmtMod(k.mod) })))),
  ];
}

function poolsCard(s) {
  const rows = [
    ...s.hitDice.map((x) => [x, `${x.name}`, x.size && `Dados de vida ${x.size}`]),
    ...s.resources.map((x) => [x, x.name, x.reset === "longRest" ? "volta no descanso longo" : x.reset === "shortRest" ? "volta no descanso curto" : ""]),
  ];
  return [
    sectionTitle("Recursos e descanso"),
    el("div", { class: "card" },
      rows.map(([p, name, hint]) => el("div", { class: "pool" },
        el("div", { class: "name" }, name, hint && el("small", { text: hint })),
        counterFor(p, name))),
      el("div", { class: "rests" },
        el("button", { class: "btn", text: "Descanso curto", onclick: () => rest("short") }),
        el("button", { class: "btn", text: "Descanso longo", onclick: () => rest("long") })),
      el("div", { class: `sync-note${config.token ? " on" : ""}`, text: config.token
        ? "Alterações salvas na ficha do DiceCloud"
        : "Alterações só neste navegador (entre no DiceCloud em Opções para salvar)" })),
  ];
}

// ---------- Abas ----------

function tabFicha(s) {
  const others = s.checks.filter((c) => !/^initiative$/i.test(c.key || ""));
  const orphanSaves = s.saves.filter((x) => !s.abilities.some((a) => abilityOf(x.key) === a.key));
  return [
    hpCard(),
    ...abilityCards(s),
    ...skillList(s),
    ...(others.length || orphanSaves.length
      ? [sectionTitle("Outros testes"), el("div", { class: "skills" }, [...orphanSaves, ...others].map((k) =>
          el("button", { class: "skill", onclick: () => rollCheck(k.name, k.mod, k.advantage) },
            el("span", { class: "dot" }), el("span", { class: "name", text: k.name }), el("span", { class: "mod", text: fmtMod(k.mod) }))))]
      : []),
    ...poolsCard(s),
  ];
}

const usesTag = (a) => a.usesTotal ? { text: `${usesLeft(a)}/${a.usesTotal}`, cls: usesLeft(a) ? "accent" : "" } : null;

function actionCard(a, prefix) {
  return entryCard({
    key: `${prefix}:${a.id}`,
    title: a.name,
    tags: [usesTag(a)],
    sub: rollSummary(a) || ACTION_TYPES[a.actionType] || "",
    use: el("button", { class: "use-btn", text: "Usar", disabled: !!(a.usesTotal && !usesLeft(a)), onclick: () => useAction(a) }),
    body: [rollChips(a), a.summary && el("p", { class: "desc", text: a.summary }), a.description && el("p", { class: "desc", text: a.description })],
  });
}

function tabAcoes(s) {
  const isAttack = (a) => a.actionType === "attack" || a.attackBonus != null;
  const weapons = s.actions.filter(isAttack);
  const others = s.actions.filter((a) => !isAttack(a));
  const out = [hpCard()];
  if (!s.actions.length) {
    out.push(el("div", { class: "empty" }, el("b", { text: "Nenhuma ação ativa" }),
      "Armas aparecem aqui quando estão equipadas no DiceCloud. As demais estão na aba Itens."));
  }
  if (weapons.length) out.push(sectionTitle("Armas e ataques"), el("div", { class: "list" }, weapons.map((a) => actionCard(a, "a"))));
  const byType = new Map();
  for (const a of others) byType.set(a.actionType, [...(byType.get(a.actionType) || []), a]);
  const order = ["action", "bonus", "reaction", "free", "long"];
  for (const type of [...byType.keys()].sort((x, y) => order.indexOf(x) - order.indexOf(y))) {
    const title = { action: "Ações", bonus: "Ações bônus", reaction: "Reações", free: "Livres", long: "Ações longas" }[type] || "Outras ações";
    out.push(sectionTitle(title), el("div", { class: "list" }, byType.get(type).map((a) => actionCard(a, "a"))));
  }
  return out;
}

const dmgLabel = (a, d) => `${a.name} (${d.damageType === "healing" ? "cura" : `dano${d.damageType ? " " + damagePt(d.damageType) : ""}`})`;
let busy = false;

/** Usar/Conjurar: gasta o que precisa, avisa a mesa e já rola o ataque e os danos. */
async function useAndRoll(a, label, sub, text) {
  if (busy) return;
  busy = true;
  const warning = spendFor(a);
  try {
    await announce(label, [...sub, a.usesTotal && `${usesLeft(a)}/${a.usesTotal} usos`], text);
    if (a.attackBonus != null) await rollCheck(`${a.name} (ataque)`, a.attackBonus, 0);
    for (const d of a.damages) if (d.notation) await rollDice(dmgLabel(a, d), d.notation);
  } finally {
    busy = false;
    if (warning) setStatus(warning, true);
  }
}

const useAction = (a) => useAndRoll(a, `usa ${a.name}`, [ACTION_TYPES[a.actionType]], a.summary || a.description);
const castSpell = (sp) => useAndRoll(
  sp, `conjura ${sp.name}`,
  [sp.level === 0 ? "Truque" : `${sp.level}º círculo`, sp.range, sp.concentration && "Concentração", sp.dc != null && sp.attackBonus == null && `CD ${sp.dc}`],
  sp.summary || sp.description);
const shareBtn = (verb, name, text) =>
  el("button", { class: "chip-btn", text: "Mostrar a todos", onclick: () => announce(`${verb} ${name}`, [], text) });

function spellCard(sp) {
  const slot = sheet.spellSlots.find((x) => x.level === sp.level);
  const noSlot = !!(sp.level > 0 && !sp.noSlot && slot && poolValue(slot) === 0);
  const meta = [
    ["Tempo", CAST_PT[sp.castingTime] || sp.castingTime],
    ["Alcance", sp.range],
    ["Duração", sp.duration],
    ["Componentes", sp.components],
    ["Escola", SCHOOL_PT[sp.school] || sp.school],
  ].filter(([, v]) => v);
  return entryCard({
    key: `s:${sp.id}`,
    title: sp.name,
    tags: [sp.concentration && { text: "C", cls: "accent" }, sp.ritual && { text: "R" }, usesTag(sp)],
    sub: rollSummary(sp) || [CAST_PT[sp.castingTime] || sp.castingTime, sp.range].filter(Boolean).join(" · "),
    use: el("button", {
      class: "use-btn", text: "Conjurar",
      title: noSlot ? "Sem espaços deste círculo" : "",
      disabled: noSlot,
      onclick: () => castSpell(sp),
    }),
    body: [
      el("dl", { class: "meta" }, meta.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })])),
      rollChips(sp),
      sp.summary && el("p", { class: "desc", text: sp.summary }),
      sp.description && el("p", { class: "desc", text: sp.description }),
    ],
  });
}

function tabMagias(s) {
  const out = [];
  const lists = s.spellLists.filter((l) => l.dc != null || typeof l.attackBonus === "number");
  for (const l of lists) {
    out.push(el("div", { class: "spell-stats" },
      el("div", { class: "stat" }, el("b", { text: l.dc != null ? String(l.dc) : "—" }), el("span", { text: "CD" })),
      el("div", { class: "stat" }, el("b", { text: typeof l.attackBonus === "number" ? fmtMod(l.attackBonus) : "—" }), el("span", { text: "Ataque" })),
      el("div", { class: "stat" }, el("b", { text: l.maxPrepared != null ? String(l.maxPrepared) : "—" }), el("span", { text: lists.length > 1 ? l.name : "Preparadas" }))));
  }
  if (!s.spells.length) return [...out, el("div", { class: "empty" }, el("b", { text: "Nenhuma magia na ficha" }))];

  const anyPrepared = s.spells.some((x) => x.prepared);
  const visible = s.spells.filter((x) => !anyPrepared || !onlyPrepared || x.prepared || x.level === 0);
  const levels = [...new Set([...visible.map((x) => x.level), ...s.spellSlots.map((x) => x.level)])].sort((a, b) => a - b);
  levels.forEach((level, i) => {
    const slot = s.spellSlots.find((x) => x.level === level);
    const label = level === 0 ? "Truques" : `${level}º círculo`;
    const filter = i === 0 && anyPrepared && el("div", { class: "filter", role: "radiogroup", "aria-label": "Quais magias mostrar" },
      el("button", { class: onlyPrepared ? "active" : "", role: "radio", "aria-checked": String(onlyPrepared), text: "Preparadas", onclick: () => { onlyPrepared = true; render(); } }),
      el("button", { class: onlyPrepared ? "" : "active", role: "radio", "aria-checked": String(!onlyPrepared), text: "Todas", onclick: () => { onlyPrepared = false; render(); } }));
    out.push(sectionTitle(label, filter || null, slot ? counterFor(slot, `espaço de ${label}`) : null));
    const spells = visible.filter((x) => x.level === level);
    out.push(spells.length
      ? el("div", { class: "list" }, spells.map(spellCard))
      : el("p", { class: "note small", text: "Nenhuma magia preparada deste círculo." }));
  });
  return out;
}

function tabItens(s) {
  if (!s.items.length) return [el("div", { class: "empty" }, el("b", { text: "Inventário vazio" }))];
  const out = [];
  const groups = new Map();
  for (const it of s.items) groups.set(it.container, [...(groups.get(it.container) || []), it]);
  for (const [container, items] of groups) {
    out.push(sectionTitle(container || "Com você"));
    out.push(el("div", { class: "list" }, items.map((it, i) => {
      const weapon = it.actions.find((a) => a.attackBonus != null || a.damages.length);
      return entryCard({
        key: `i:${container}:${i}:${it.name}`,
        title: it.quantity !== 1 ? `${it.quantity}× ${it.name}` : it.name,
        tags: [it.equipped && { text: "equipado", cls: "good" }, it.attuned && { text: "sintonizado", cls: "accent" }],
        sub: weapon ? rollSummary(weapon) : [it.weight && `${it.weight} lb`, it.value && `${it.value} po`].filter(Boolean).join(" · "),
        use: weapon ? el("button", { class: "use-btn", text: "Usar", onclick: () => useAction(weapon) }) : null,
        body: [
          ...it.actions.map(rollChips),
          el("div", { class: "actions" }, shareBtn("mostra", it.name, it.description)),
          it.description && el("p", { class: "desc", text: it.description }),
        ],
      });
    })));
  }
  return out;
}

function tabMais(s) {
  const out = [];
  const list = (title, entries, verb, prefix) => {
    if (!entries.length) return;
    out.push(sectionTitle(title), el("div", { class: "list" }, entries.map((x, i) => entryCard({
      key: `${prefix}:${i}:${x.name}`,
      title: x.name,
      sub: x.summary ? clip(x.summary, 90) : "",
      body: [
        el("div", { class: "actions" }, shareBtn(verb, x.name, x.summary || x.description)),
        x.summary && el("p", { class: "desc", text: x.summary }),
        x.description && el("p", { class: "desc", text: x.description }),
      ],
    }))));
  };
  list("Efeitos ativos", s.buffs, "está sob o efeito de", "b");
  list("Características", s.features, "usa", "f");
  const profs = [["Armaduras", s.proficiencies.armor], ["Armas", s.proficiencies.weapon], ["Ferramentas", s.proficiencies.tool], ["Idiomas", s.proficiencies.language]]
    .filter(([, names]) => names.length);
  if (profs.length) {
    out.push(sectionTitle("Proficiências"), el("div", { class: "card" },
      el("dl", { class: "meta", style: "margin:0" }, profs.flatMap(([k, names]) => [el("dt", { text: k }), el("dd", { text: names.join(", ") })]))));
  }
  list("Anotações", s.notes, "mostra", "n");
  return out.length ? out : [el("div", { class: "empty" }, el("b", { text: "Nada mais na ficha" }))];
}

function tabLog() {
  if (!log.length) {
    return [el("div", { class: "empty" }, el("b", { text: "Nenhuma rolagem ainda" }), "As rolagens de toda a mesa aparecem aqui.")];
  }
  return [sectionTitle("Últimas rolagens da mesa"), el("div", { class: "list" }, log.slice(-30).reverse().map((e) => {
    const use = e.kind === "use";
    return el("div", { class: `log-item${use ? " use" : e.nat === 20 ? " crit" : e.nat === 1 ? " fumble" : ""}` },
      el("div", { class: "log-total" }, use ? icon("spark") : String(e.total)),
      el("div", { class: "log-text" },
        el("b", { text: use ? `${e.character} ${e.label}` : e.label }),
        el("span", { text: [use ? e.sub : e.detail, !use && e.character, e.player].filter(Boolean).join(" · ") })));
  }))];
}

function welcome() {
  return el("div", { class: "welcome" },
    el("span", { html: `<svg viewBox="0 0 24 24" class="d20" aria-hidden="true">${ICONS.d20}</svg>` }),
    el("h2", { text: "Traga sua ficha para a mesa" }),
    el("p", { text: "Role testes, ataques e magias do DiceCloud direto no Owlbear, com o resultado para todos." }),
    el("ol", { class: "steps" },
      el("li", {}, el("span", {}, "No DiceCloud, abra sua ficha e em ", el("b", { text: "Compartilhar" }), " deixe visível para quem tem o link.")),
      el("li", {}, el("span", {}, "Copie o endereço da ficha no navegador.")),
      el("li", {}, el("span", {}, "Cole abaixo e toque em ", el("b", { text: "Carregar ficha" }), "."))),
    el("div", { class: "card" },
      el("input", { id: "welcomeLink", type: "url", placeholder: "https://dicecloud.com/character/…", value: config.link }),
      el("button", { class: "btn primary wide", text: "Carregar ficha", onclick: () => saveLink($("welcomeLink").value) })));
}

const TABS = { ficha: tabFicha, acoes: tabAcoes, magias: tabMagias, itens: tabItens, mais: tabMais, log: tabLog };

function render() {
  const has = !!sheet;
  document.querySelector(".tabs").hidden = !has;
  $("modes").hidden = !has || !["ficha", "acoes", "magias"].includes(tab);
  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  });
  if (has) {
    $("charName").textContent = sheet.name;
    $("charSub").textContent = [
      sheet.level ? `Nível ${sheet.level}` : "",
      sheet.classes.map((c) => c.name).join(" / "),
    ].filter(Boolean).join(" · ") || "Personagem";
    const av = $("avatar");
    if (sheet.avatar) { av.style.backgroundImage = `url("${sheet.avatar.replace(/"/g, "%22")}")`; av.textContent = ""; }
    else { av.style.backgroundImage = ""; av.textContent = sheet.name.trim().charAt(0).toUpperCase() || "?"; }
    $("quick").replaceChildren(...quickStats(sheet));
  } else {
    $("quick").replaceChildren();
  }
  const scroll = $("sheet").scrollTop;
  $("sheet").replaceChildren(...(has ? TABS[tab](sheet) : [welcome()]).filter(Boolean));
  $("sheet").scrollTop = scroll;
}

// ---------- Rolagens ----------

const SOURCE = "dicecloud-roller";
const pending = new Map(); // rollId -> { label, mod, kind, timer, resolve }
let dicePlusReady = false;
let dicePlusMissingUntil = 0; // sem Dice+: não procura de novo por 30 s (evita atrasar cada rolagem)

function checkDicePlus() {
  if (dicePlusReady) return Promise.resolve(true);
  if (Date.now() < dicePlusMissingUntil) return Promise.resolve(false);
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const done = (ok) => {
      clearTimeout(timer); unsubscribe(); dicePlusReady = ok;
      if (!ok) dicePlusMissingUntil = Date.now() + 30000;
      resolve(ok);
    };
    const unsubscribe = OBR.broadcast.onMessage("dice-plus/isReady", (event) => {
      if (event.data?.requestId === requestId && "ready" in event.data) done(true);
    });
    const timer = setTimeout(() => done(false), 1000);
    OBR.broadcast.sendMessage("dice-plus/isReady", { requestId, timestamp: Date.now() }, { destination: "ALL" });
  });
}

/** Pede a rolagem ao Dice+; a promessa termina quando o resultado (ou erro) chega. */
function sendToDicePlus(diceNotation, info) {
  return new Promise((resolve) => {
    const rollId = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (pending.delete(rollId)) setStatus("O Dice+ não respondeu a tempo.", true);
      resolve();
    }, 30000);
    pending.set(rollId, { ...info, timer, resolve });
    Promise.all([OBR.player.getId(), OBR.player.getName()]).then(([playerId, playerName]) =>
      OBR.broadcast.sendMessage("dice-plus/roll-request", {
        rollId,
        playerId,
        playerName,
        rollTarget: "everyone",
        diceNotation,
        showResults: false, // o resultado aparece no nosso cartão de notificação
        timestamp: Date.now(),
        source: SOURCE,
      }, { destination: "ALL" }));
  });
}

async function onDicePlusResult(data) {
  const p = pending.get(data?.rollId);
  if (!p) return; // rolagem de outro jogador
  clearTimeout(p.timer);
  pending.delete(data.rollId);
  const result = data.result || {};
  let outcome;
  if (p.kind === "d20") {
    const d20s = (result.groups || []).filter((g) => g.diceType === "d20").flatMap((g) => g.dice || []);
    const values = d20s.map((d) => d.value);
    const kept = d20s.find((d) => d.kept)?.value ?? (typeof result.totalValue === "number" ? result.totalValue - p.mod : values[0]);
    outcome = d20Result(values.length ? values : [kept], kept, p.mod);
  } else {
    const summary = String(result.rollSummary || "");
    const cut = summary.lastIndexOf(" = ");
    outcome = { detail: cut > 0 ? summary.slice(0, cut) : summary || p.notation, total: result.totalValue, nat: null };
  }
  await publish({ label: p.label, ...outcome });
  p.resolve();
}

async function publish(partial) {
  const entry = {
    player: OBR.isAvailable ? await OBR.player.getName() : "",
    character: sheet?.name || "",
    avatar: sheet?.avatar || "",
    at: Date.now(),
    ...partial,
  };
  if (OBR.isAvailable) await OBR.broadcast.sendMessage(CHANNEL, entry, { destination: "ALL" });
  else addToLog(entry); // modo de teste fora do Owlbear
}

/** Avisa a todos que algo foi usado (ação, magia, característica, item, efeito). */
function announce(label, subParts = [], text = "") {
  return publish({ kind: "use", label, sub: subParts.filter(Boolean).join(" · "), text: clip(text) });
}

let noDicePlusNotice = "pending"; // avisa uma vez, junto com o primeiro resultado
async function useDicePlus() {
  if (!OBR.isAvailable) return false;
  const ok = await checkDicePlus();
  if (ok) noDicePlusNotice = "done";
  return ok;
}

/** d20 + modificador. Vantagem: o seletor manda; em "Normal" vale o que a ficha define. */
async function rollCheck(label, mod, sheetAdvantage = 0) {
  const effective = mode !== "normal" ? mode : sheetAdvantage > 0 ? "adv" : sheetAdvantage < 0 ? "dis" : "normal";
  const fullLabel = label + (effective === "adv" ? " (vantagem)" : effective === "dis" ? " (desvantagem)" : "");
  if (await useDicePlus()) {
    const dice = effective === "adv" ? "2d20kh1" : effective === "dis" ? "2d20kl1" : "1d20";
    return sendToDicePlus(`${dice}${mod >= 0 ? "+" : "-"}${Math.abs(mod)}`, { label: fullLabel, mod, kind: "d20" });
  }
  await publish({ label: fullLabel, ...rollD20(mod, effective) });
}

/** Dados livres (dano), ex.: "2d6+3". */
async function rollDice(label, notation) {
  if (await useDicePlus()) return sendToDicePlus(notation, { label, notation, kind: "dice" });
  const outcome = rollNotation(notation);
  if (!outcome) return setStatus(`Não sei rolar "${notation}".`, true);
  await publish({ label, ...outcome });
}

function addToLog(entry) {
  log.push(entry);
  log = log.slice(-30);
  if (tab === "log") render();
  // Confirmação discreta das próprias rolagens dentro do painel
  if (entry.kind !== "use" && entry.character === sheet?.name) {
    const notice = noDicePlusNotice === "pending" && OBR.isAvailable && !dicePlusReady;
    if (notice) noDicePlusNotice = "done";
    setStatus("", false, [
      entry.label, ":", el("b", { text: String(entry.total) }),
      notice && el("small", { class: "notice", text: "Dice+ não está na sala, então os dados 3D não aparecem. A rolagem vale normalmente." }),
    ]);
    if (notice) { clearTimeout(statusTimer); statusTimer = setTimeout(() => { $("status").hidden = true; }, 7000); }
  }
}

// ---------- Carregamento ----------

async function loadSheet({ silent = false } = {}) {
  const id = extractCreatureId(config.link);
  if (!id) {
    sheet = null;
    render();
    if (config.link) setStatus("Esse link não parece ser de uma ficha do DiceCloud.", true);
    return;
  }
  const reload = $("reload");
  if (!silent) reload.classList.add("spin");
  try {
    const text = await fetchCreatureText(id, config);
    if (text === lastText) return;
    sheet = parseCreature(JSON.parse(text));
    if (!sheet.healthBars.some((p) => p.ignoreUpper)) {
      // A ficha não tem barra de vida temporária: usa um contador local (não vai para o DiceCloud).
      sheet.healthBars.push({ id: `local-temp-${id}`, key: "", name: "Vida temporária", total: 0, damage: 0, reset: "", ignoreUpper: true, ignoreLower: false, local: true });
    }
    lastText = text;
    pruneOverrides(sheet);
    render();
  } catch (err) {
    if (!silent) setStatus(err.message, true);
  } finally {
    reload.classList.remove("spin");
  }
}

function saveLink(value) {
  config.link = String(value || "").trim();
  store.set(CFG_KEY, config);
  $("link").value = config.link;
  lastText = "";
  loadSheet();
}

function showLoginState() {
  $("loginForm").hidden = !!config.token;
  $("loggedIn").hidden = !config.token;
}

function setupUi() {
  $("link").value = config.link;
  $("proxy").value = config.proxy;
  showLoginState();

  const openSettings = (open) => {
    $("settings").hidden = !open;
    if (open) $("link").focus();
  };
  $("openSettings").addEventListener("click", () => openSettings(true));
  $("closeSettings").addEventListener("click", () => openSettings(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") openSettings(false); });

  $("save").addEventListener("click", () => {
    config.proxy = $("proxy").value.trim();
    openSettings(false);
    saveLink($("link").value);
  });
  $("reload").addEventListener("click", () => { lastText = ""; loadSheet(); });

  $("doLogin").addEventListener("click", async () => {
    $("loginState").textContent = "Entrando…";
    try {
      config.token = await login($("user").value.trim(), $("pass").value, $("proxy").value.trim());
      $("pass").value = "";
      store.set(CFG_KEY, config);
      $("loginState").textContent = "";
      showLoginState();
      render();
    } catch (err) {
      $("loginState").textContent = err.message;
    }
  });
  $("logout").addEventListener("click", () => {
    config.token = "";
    store.set(CFG_KEY, config);
    showLoginState();
    render();
  });

  for (const b of document.querySelectorAll("[data-mode]")) {
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      document.querySelectorAll("[data-mode]").forEach((x) => {
        x.classList.toggle("active", x === b);
        x.setAttribute("aria-checked", String(x === b));
      });
    });
  }
  for (const b of document.querySelectorAll("[data-tab]")) {
    b.addEventListener("click", () => { tab = b.dataset.tab; $("sheet").scrollTop = 0; render(); });
  }
}

setupUi();
render();
loadSheet();
// Recarrega sozinha para acompanhar mudanças feitas no DiceCloud.
setInterval(() => { if (!document.hidden) loadSheet({ silent: true }); }, REFRESH_MS);

if (OBR.isAvailable) {
  OBR.onReady(async () => {
    const applyTheme = (theme) => (document.documentElement.dataset.theme = theme.mode === "LIGHT" ? "light" : "dark");
    applyTheme(await OBR.theme.getTheme());
    OBR.theme.onChange(applyTheme);
    OBR.broadcast.onMessage(CHANNEL, (event) => addToLog(event.data));
    OBR.broadcast.onMessage(`${SOURCE}/roll-result`, (event) => onDicePlusResult(event.data));
    OBR.broadcast.onMessage(`${SOURCE}/roll-error`, (event) => {
      const p = pending.get(event.data?.rollId);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(event.data.rollId);
      setStatus(`Dice+ recusou a rolagem: ${event.data.error || "erro desconhecido"}`, true);
      p.resolve();
    });
  });
}
